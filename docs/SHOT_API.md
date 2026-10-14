# SHOT API

Mỗi shot là **thân một hàm** `function (s) { ... }`, được gọi lại cho từng khung hình.
Hàm phải tất định: cùng `s.t` → cùng hình ảnh (không `Math.random`, không `Date`).
Toạ độ logic luôn là `s.W × s.H` (mặc định 1920×1080), gốc ở góc trên-trái, trục y hướng xuống.

## Thời gian
| Thuộc tính | Ý nghĩa |
|---|---|
| `s.t` | thời gian cục bộ trong shot (giây). Trong lúc chuyển cảnh ra, `t` có thể > `s.d` |
| `s.d` | độ dài shot (giây) |
| `s.p` | tiến độ 0→1 (`t/d`, đã kẹp) |
| `s.prog(a, b)` | tiến độ 0→1 giữa giây `a` và `b` |
| `s.ease.*` | `linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, outQuart, inOutQuart, outExpo, inExpo, inOutExpo, outBack, inOutSine, outSine, cine` |
| `s.lerp(a,b,k)`, `s.clamp(v,a,b)`, `s.map(v,a,b,c,d)`, `s.smoothstep(a,b,v)` | toán |
| `s.rand(seed)` | RNG có seed: `r()`, `r.range(a,b)`, `r.int(a,b)`, `r.pick(arr)`, `r.gauss()` |
| `s.noise(x,y,seed)`, `s.fbm(x,y,seed)` | nhiễu mượt −1..1 |
| `s.palette` | `{ primary, accent, text }` theo Phong cách dự án |

## Vật lý (giải tích, tua tới lui chính xác)
- `s.spring({ from, to, stiffness=120, damping=14, mass=1, velocity, delay })` → số. Dao động tắt dần (lò xo).
- `s.physics.drop({ from, floor, gravity=4000, restitution=0.35, delay })` → `{ y, vy, contact, squash, impacts }`. Vật rơi tăng tốc, nảy theo hệ số đàn hồi, nằm yên.
- `s.physics.pendulum({ amplitude, period, decay, delay })` → góc (rad), đung đưa tắt dần.

## Camera
`s.camera({ zoom, x, y, rotate, shake })` — gọi **trước** khi vẽ. `shake` = biên độ rung tay (px) dùng nhiễu mượt.
Mọi lệnh vẽ có `depth` (0..1+) để tạo thị sai: `depth: 1` đi theo camera hoàn toàn, `depth: 0` cố định (UI/chữ).
Mặc định: ảnh & fx `depth 1`; bokeh 0.3; chữ/badge/underline `depth 0`.

## Vẽ
- `s.background(color | [c1,c2,...] | { radial:[c1,c2], x, y, r })`
- `s.image(name, opts)` → `{x,y,w,h,cx,cy}` hình chữ nhật đã vẽ (dùng cho sheen/bóng).
  - kích thước: `w` / `h` (giữ tỉ lệ) hoặc `fit: 'cover'|'contain'` (phủ khung)
  - `x, y` = điểm neo (mặc định giữa khung), `anchor: [ax, ay]` (0..1, mặc định `[0.5,0.5]`; đặt `[0.5,1]` để neo đáy sản phẩm xuống sàn)
  - `scale, rotate, flipX, skewX, opacity, blend, depth, crop:[x,y,w,h]` (chuẩn hoá 0..1)
  - bộ lọc: `blur, brightness, contrast, saturate, hue`
  - `shadow: true | { y, blur, color }` — bóng đổ theo alpha của ảnh (PNG trong suốt)
  - `reflect: true | { opacity, height, gap, blur }` — phản chiếu trên mặt bóng
- `s.video(name, { ...như image, time, rate, offset, loop })` — clip video làm chất liệu.
- `s.contactShadow({ x, y, width, opacity, squash })` — bóng tiếp xúc mềm dưới vật.
- `s.droplet({ x, y, r, material, vx, vy, light })` — một giọt chất lỏng đơn.
- `s.layer({ blur, opacity, blend, brightness, saturate }, (s) => { ... })` — vẽ vào lớp riêng rồi ghép (rack focus, hậu cảnh mờ).
- `s.world((ctx) => { ... }, depth)` — vẽ canvas 2D tự do (ctx) có áp camera.
- `s.ctx` — CanvasRenderingContext2D thô (đã scale về toạ độ logic).

## Chữ & biểu tượng
- `s.text(str, { x, y, size=72, weight=700, font:'sans'|'serif', color, accent, align:'left'|'center'|'right', anim:'rise'|'fade'|'blur'|'pop'|'wipe'|'type'|'none', start, dur, stagger, out, outDur, maxWidth, lineHeight, letterSpacing, italic, shadow })`
  - `*từ nhấn*` hiển thị màu `accent`. `y` là đường chân chữ dòng đầu. Xuống dòng bằng `maxWidth`.
  - `out`: thời điểm (s) chữ bắt đầu biến mất.
- `s.underline({ x, y, width, thickness, color, color2, start, dur })`
- `s.badge({ icon, label, x, y, size=120, start, dur, color, ring })` — vòng tròn + icon + nhãn, bật lò xo.
- `s.icon(name, { x, y, size, color, stroke, fill })`
- Icon: `drop sun shield leaf sparkle heart check star bolt flask clock moon wave gift cart arrow play snow fire`

## Hiệu ứng vật lý & chất liệu — `s.fx.*`
Tất cả nhận thêm `depth`. Vật liệu `material`: `serum | water | milk | honey | oil | gel | cream | juice | coffee | wine`
hoặc tuỳ biến `{ base:'serum', color:'#c67a1c', core:'#ffd27a', edge:'#4a2200', opacity, viscosity, gloss }`.
Độ nhớt (`viscosity`) ảnh hưởng cả vật lý (ít giọt hơn, giọt to hơn, chậm hơn) lẫn quang học.

| Hàm | Mô tả & tham số chính |
|---|---|
| `liquidCrown` (`splash`) | Giọt rơi → vương miện bắn (gai thắt cổ thành giọt, bụi nước), sụp → tia Worthington, gợn sóng lan, giọt rơi lại tạo gợn mới. `x, y` (điểm va chạm trên mặt chất lỏng), `radius` (px), `start` (giây va chạm), `material, tilt=0.28` (phối cảnh mặt nước), `energy=1` (0.4..1.6), `spread, spikes, spray, jet, drop=true, dropFrom, slowmo=1` (>1 = quay chậm), `pool` (vẽ mặt hồ), `light:{x,y}`, `opacity`. Trả về `{ impactTime, sheetEnd, jetTime }`. |
| `pour` | Dòng rót mỏng dần theo trọng lực, vùng va chạm + giọt văng. `x, y, surfaceY, width, speed, start, end, material, wobble` |
| `drip` | Giọt treo căng dần → thắt cổ → rơi, lặp chu kỳ. `x, y, size, period, start, material, floorY` |
| `burst` | Hạt vật lý (trọng lực, lực cản, nhiễu loạn, nảy sàn). `kind: 'droplet'|'image'|'confetti'|'petal'|'powder'|'spark'`, `x, y, start, count, speed:[min,max], angle, spread, size:[min,max], gravity, drag, turbulence, floorY, restitution, spin, depth (bool), image (tên chất liệu), material, colors, life, seed` |
| `mist` (`smoke`) | Khói / hơi nước cuộn. `x, y, rate, life, rise, wind, spread, size, color, opacity, start` |
| `bubbles` | Bọt khí nổi (to nổi nhanh hơn). `rect:[x,y,w,h], count, size:[a,b], speed, clip` |
| `caustics` | Vân sáng khúc xạ dưới nước. `rect, scale, speed, intensity, color, softness` |
| `rays` | Tia sáng thể tích. `x, y, angle, count, length, color, opacity` |
| `bokeh` | Đốm sáng ngoài nét. `count, size:[a,b], color, opacity, drift, rise` |
| `dust` | Bụi bay bắt sáng. `count, size, color, opacity, wind, rise` |
| `sheen` | Vệt sáng lướt trên thuỷ tinh/kim loại. `rect:[x,y,w,h]` (dùng kết quả `s.image`), `image` (tên, để mask theo hình), `start, duration, angle, width, intensity` |
| `flare` | Lens flare anamorphic. `x, y, intensity, color` |
| `leak` | Light leak phim. `intensity, color, color2, seed` |

## Hậu kỳ (toàn video, chỉnh ở tab Phong cách)
`style.grade` (`none warm golden cinematic clean cool luxe film mono`), `vignette`, `grain`, `bloom`, `letterbox`.
Khi xuất, motion blur (nhiều mẫu/khung) được áp tự động.

## Chuyển cảnh (trường `transition` của shot)
`cut fade dissolve flash push zoom whip blur wipe rise`, `duration` giây. Shot trước tiếp tục chạy trong thời gian chuyển cảnh (t > d).
