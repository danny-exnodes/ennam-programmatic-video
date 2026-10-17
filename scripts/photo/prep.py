#!/usr/bin/env python3
"""Prepare a real photo for 2.5D "filmed" plates (engine: s.photo / fx/photogl.js).

Outputs next to --out:
  <name>.jpg        photo resized to --width
  <name>.depth.png  8-bit relative inverse depth (white = near), edge-aware refined
  <name>.mask.png   R = water (flow animation), G = foliage sway, B = sky
  <name>.flow.png   R,G = flow direction in screen space (0.5 = zero), B = speed

Depth: Depth Anything V2 small (ONNX, Apache-2.0)
  https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx

Masks come from a JSON spec (normalised 0..1 image coordinates):
  { "water":   [ {"poly": [[x,y],...], "spine": [[x,y],...] | "dir": [dx,dy], "speed": 1} ],
    "sway":    [ {"poly": [...], "amount": 1} ],
    "sky":     [ {"poly": [...]} ],
    "autoSway": 0.6,          # add sway to pixels that look like foliage (green/texture), scaled
    "feather": 0.006 }
usage: python3 scripts/photo/prep.py photo.jpg --name river --out assets/ --spec river.json --model da2_vits.onnx
"""
import argparse, json, os
import numpy as np
import cv2

ap = argparse.ArgumentParser()
ap.add_argument('photo')
ap.add_argument('--name', required=True)
ap.add_argument('--out', default='.')
ap.add_argument('--spec')
ap.add_argument('--width', type=int, default=2560)
ap.add_argument('--model', default=os.path.expanduser('~/models/da2_vits.onnx'))
ap.add_argument('--crop', help='x0,y0,x1,y1 normalised crop before resize')
a = ap.parse_args()

img = cv2.imread(a.photo, cv2.IMREAD_COLOR)
if a.crop:
    x0, y0, x1, y1 = [float(v) for v in a.crop.split(',')]
    h, w = img.shape[:2]
    img = img[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
h, w = img.shape[:2]
W = min(a.width, w)
H = int(round(h * W / w))
img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
os.makedirs(a.out, exist_ok=True)
base = os.path.join(a.out, a.name)
cv2.imwrite(base + '.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 93])

# ---- depth
import onnxruntime as ort
sess = ort.InferenceSession(a.model, providers=['CPUExecutionProvider'])
S = 518
x = cv2.resize(img, (S, S), interpolation=cv2.INTER_CUBIC)[:, :, ::-1].astype(np.float32) / 255.0
x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
x = x.transpose(2, 0, 1)[None].astype(np.float32)
d = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
# also run on the horizontally flipped image and average (reduces artefacts)
d2 = sess.run(None, {sess.get_inputs()[0].name: x[:, :, :, ::-1].copy()})[0][0][:, ::-1]
d = 0.5 * (d + d2)
d = cv2.resize(d, (W, H), interpolation=cv2.INTER_CUBIC)
lo, hi = np.percentile(d, 0.5), np.percentile(d, 99.5)
d = np.clip((d - lo) / (hi - lo + 1e-6), 0, 1).astype(np.float32)
guide = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
try:
    d = cv2.ximgproc.guidedFilter(guide, d, radius=max(4, W // 400), eps=1e-3)
except Exception:
    pass
d = np.clip(d, 0, 1)
cv2.imwrite(base + '.depth.png', (d * 255 + 0.5).astype(np.uint8))

# ---- masks + flow
spec = json.load(open(a.spec)) if a.spec else {}
feather = spec.get('feather', 0.006) * W
water = np.zeros((H, W), np.float32)
sway = np.zeros((H, W), np.float32)
sky = np.zeros((H, W), np.float32)
fx = np.zeros((H, W), np.float32)
fy = np.zeros((H, W), np.float32)
fs = np.zeros((H, W), np.float32)


def poly_mask(poly):
    m = np.zeros((H, W), np.uint8)
    pts = np.array([[p[0] * W, p[1] * H] for p in poly], np.int32)
    cv2.fillPoly(m, [pts], 255, lineType=cv2.LINE_AA)
    return m.astype(np.float32) / 255.0


yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
for r in spec.get('water', []):
    m = poly_mask(r['poly'])
    sp = r.get('speed', 1.0)
    if 'spine' in r:
        pts = np.array([[p[0] * W, p[1] * H] for p in r['spine']], np.float32)
        best = np.full((H, W), 1e12, np.float32)
        dx = np.zeros((H, W), np.float32)
        dy = np.zeros((H, W), np.float32)
        for i in range(len(pts) - 1):
            p, q = pts[i], pts[i + 1]
            v = q - p
            L2 = float(v @ v) + 1e-6
            t = np.clip(((xx - p[0]) * v[0] + (yy - p[1]) * v[1]) / L2, 0, 1)
            ex, ey = xx - (p[0] + t * v[0]), yy - (p[1] + t * v[1])
            dd = ex * ex + ey * ey
            sel = dd < best
            best[sel] = dd[sel]
            n = np.sqrt(L2)
            dx[sel] = v[0] / n
            dy[sel] = v[1] / n
        dirx, diry = dx, dy
    else:
        v = np.array(r.get('dir', [0, 1]), np.float32)
        v /= np.linalg.norm(v) + 1e-6
        dirx = np.full((H, W), v[0], np.float32)
        diry = np.full((H, W), v[1], np.float32)
    water = np.maximum(water, m)
    fx += dirx * m * sp
    fy += diry * m * sp
    fs += m
for r in spec.get('sway', []):
    sway = np.maximum(sway, poly_mask(r['poly']) * r.get('amount', 1.0))
for r in spec.get('sky', []):
    sky = np.maximum(sky, poly_mask(r['poly']))

auto = spec.get('autoSway', 0)
if auto:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    g = ((hsv[:, :, 0] > 25) & (hsv[:, :, 0] < 95)).astype(np.float32) * np.clip(hsv[:, :, 1] / 90, 0, 1)
    lap = np.abs(cv2.Laplacian(guide, cv2.CV_32F, ksize=3))
    tex = np.clip(cv2.GaussianBlur(lap, (0, 0), 3) * 12, 0, 1)
    fol = cv2.GaussianBlur(np.maximum(g, tex * 0.6) * (1 - water) * (1 - sky), (0, 0), 4)
    sway = np.maximum(sway, np.clip(fol, 0, 1) * auto)

k = max(1, int(feather))
blur = lambda m: cv2.GaussianBlur(m, (0, 0), k)
water, sway, sky = blur(water), blur(sway), blur(sky)
fs_b = blur(fs) + 1e-4
fxb, fyb = blur(fx) / fs_b, blur(fy) / fs_b
speed = np.sqrt(fxb ** 2 + fyb ** 2)
mag = np.maximum(speed, 1e-4)
dxn, dyn = fxb / mag, fyb / mag
mask = np.dstack([sky, sway, water])  # BGR order for cv2 -> R=water, G=sway, B=sky
cv2.imwrite(base + '.mask.png', np.clip(mask * 255 + 0.5, 0, 255).astype(np.uint8))
flow = np.dstack([np.clip(speed / 2, 0, 1), dyn * 0.5 + 0.5, dxn * 0.5 + 0.5])
cv2.imwrite(base + '.flow.png', np.clip(flow * 255 + 0.5, 0, 255).astype(np.uint8))
print(json.dumps({'name': a.name, 'width': W, 'height': H}))
