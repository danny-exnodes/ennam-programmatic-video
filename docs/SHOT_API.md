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

## Trường sửa được — `s.field(key, mặc định, { type, label, maxLength })`
Chữ/giá/CTA/màu/ảnh mà người dùng có thể muốn đổi **không viết cứng** trong code: khai báo bằng `s.field` để Inspector sinh form sửa (không cần code, không tốn lượt AI).
Trả về `shot.fields[key]` nếu người dùng đã nhập, ngược lại trả `mặc định`. Không phụ thuộc `s.t`: khai báo ở đầu thân shot, ngoài mọi `if` theo thời gian.
- `type`: `'text'` (mặc định) | `'color'` (chuỗi màu CSS) | `'number'` | `'image'` (tên chất liệu, dùng cho `s.image`). `label`: nhãn tiếng Việt trên form. `maxLength`: giới hạn ký tự (text).
- `key` duy nhất trong một shot, dạng ngắn gọn: `headline`, `price`, `cta`, `brand_color`, `product`.
```js
const headline = s.field('headline', 'Sáng mịn, *tươi tắn*', { label: 'Tiêu đề', maxLength: 60 });
const color = s.field('accent', s.palette.accent, { type: 'color', label: 'Màu nhấn' });
const product = s.field('product', 'serum', { type: 'image', label: 'Ảnh sản phẩm' });
s.image(product, { h: 640, x: 1300, y: 560 });
s.text(headline, { x: 160, y: 520, size: 96, accent: color, maxWidth: 900, maxLines: 2 });
```

## Chữ & biểu tượng
- `s.text(str, { x, y, size=72, weight=700, font:'sans'|'serif', color, accent, align:'left'|'center'|'right', anim:'rise'|'fade'|'blur'|'pop'|'wipe'|'type'|'none', start, dur, stagger, out, outDur, maxWidth, maxLines, minSize, lineHeight, letterSpacing, italic, shadow })`
  - `*từ nhấn*` hiển thị màu `accent`. `y` là đường chân chữ dòng đầu. Xuống dòng bằng `maxWidth`.
  - Tự co chữ: nếu một dòng vẫn rộng hơn `maxWidth` (từ quá dài) hoặc số dòng vượt `maxLines`, cỡ chữ tự giảm (không nhỏ hơn `minSize` nếu có đặt) cho vừa. `maxLines: 1` = một dòng, không xuống dòng, chỉ co. Luôn đặt `maxWidth` cho chữ lấy từ `s.field`.
  - Trả về `{ width, height, lines, size }` (`size` = cỡ chữ thực tế sau khi co).
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

## Thiên nhiên 3D — `s.nature(...)` (gió, lá rơi, nước chảy, giọt sương)
Một thế giới 3D thật (đơn vị **mét**, trục Y hướng lên, mặt nước ở `Y = 0`, camera nhìn theo +Z) dùng chung **một trường gió** và **một đồng hồ**:
lá rơi, cỏ lau, lá có sương và mặt nước đều phản ứng với cùng một cơn gió; lá/giọt rơi xuống nước tạo gợn sóng thật (mô phỏng sóng),
mọi thứ phía trên nước được phản chiếu (phản xạ phẳng bị méo theo pháp tuyến sóng). Nước và lá chính được tô bằng WebGL2.

```js
const sc = s.nature({
  camera: { x, height: 0.5, z, pitch: 0.12, yaw: 0, fov: 45, focus: 3, aperture: 10 }, // focus/aperture = độ sâu trường ảnh
  wind: { speed: 1.3, dir: 0.1, gust: 1, gusts: [{ t: 1.0, amp: 1.7, dur: 1.4 }], turbulence: 0.35, seed },
  sun: { elevation: 0.3, azimuth: -0.4, intensity: 1.1 },   // azimuth là hướng thế giới (0 = phía trước +Z)
  sky: { top: '#6c98c0', horizon: '#f0e4c2' },
  time,            // tuỳ chọn: thời gian mô phỏng (dùng để quay chậm / speed ramp), mặc định s.t
});
sc.sky();
sc.treeline({ z: 18, height: 5.5, color: '#2b4123' });           // bờ cây xa, có phản chiếu
sc.water({ flow: [0.45, 0], depth: 0.4, farZ: 17.6, foam: 0.3 });  // gọi TRƯỚC sc.leaves để lá biết nổi trên nước
sc.reeds({ x: [-2.4, -1.4], z: [1.6, 3.2], count: 30, height: [0.45, 1.05] });
sc.leaves({ count: 30, start: -6, end: 6, colors: 'autumn', z: [1.2, 5], size: [0.04, 0.07] });
const leaf = sc.leaf({ anchor: [x, y, z], yaw, pitch: 0.3, length: 0.095, drops: [{ u: 0.3, v: 0.06, r: 0.003 }, ...], releaseBy: 4.3 });
sc.render();      // vẽ theo đúng thứ tự: trời → bờ → phản chiếu → nước → lá nổi → lá bay → lá chính + sương
```
| Hàm | Ý nghĩa & tham số |
|---|---|
| `sc.water` | `flow:[vx,vz]` m/s (dòng chảy, gợn sóng trôi theo), `depth`, `color`, `clarity`, `farZ` (nước kết thúc ở bờ xa), `foam`, `chop` (độ gợn do gió), `wavelength:[min,max]`, `caustics`, `bedA/bedB` (màu sỏi đáy), `blur` (mặc định tự tính theo DOF), `res` (độ phân giải shading 0.5–1), `simArea:[x0,z0,x1,z1]`, `ripples:false` |
| `sc.leaves` | Lá rơi khí động học (đong đưa, lượn, lộn vòng, bị gió cuốn), chạm nước thì nổi và trôi theo dòng. `count, start, end, colors:'autumn'|'green'|'spring'|'mixed'|[...], size:[a,b]` (nửa chiều dài, m), `z:[a,b]`, `area`, `tumble` (tỉ lệ lá lộn vòng), `flutter` |
| `sc.reeds` | Cỏ lau/ cỏ ven bờ uốn theo gió (gió giật quét qua từ phía đầu gió). `x, z, count, height, color, stiffness` |
| `sc.leaf` | Lá chính có giọt sương: lá đung đưa theo gió + trọng lượng giọt; giọt bị ghim cho tới khi trọng lực thắng (giọt to mới trượt), gom giọt nhỏ trên đường, treo ở mũi lá, rơi theo định luật Tate (hoặc `releaseBy` giây), rơi xuống nước → hố + tia Worthington + giọt phụ + gợn sóng. Trả về `{ slide, tip, release, impact, impactAt }` (giây mô phỏng) để căn camera/chữ. Tham số: `anchor, yaw, pitch, roll, length, width, curve, color, color2, drops:[{u,v,r}]` (u 0→1 từ cuống tới mũi, v −1..1 ngang lá, r bán kính m), `freq, windGain, loadGain, pin, tipRadius, drag, twig` |
| `sc.backdrop(fn,{z})` | Vẽ phông tuỳ ý ở độ sâu z (fn nhận `ctx, project, mirror`) — có phản chiếu |
| `sc.impulse({t,x,z,r,amp})` | Thêm một cú chạm mặt nước tuỳ ý |
| `sc.project(x,y,z)` | Toạ độ thế giới → `[sx, sy, depth]` trên khung |

Mẹo: quay chậm bằng `time` (ví dụ `time: T0 - 0.12 + 0.2 * s.t`), cả lá, nước, gió đều chậm theo. Hai shot dùng chung `wind` + `leaf` sẽ cho cùng một giọt nước — dùng `s.nature({ wind }).leaf(LEAF).impact[0]` để biết thời điểm chạm nước. Xem ví dụ đầy đủ ở `examples/nature/`.
Không dùng `s.camera(...)` 2D cho cảnh nature; chuyển động camera đặt trong `camera` của `s.nature`.

### Thiên nhiên 3D — phần mở rộng (núi rừng, đá suối, lá tiền cảnh, chim én, chai sản phẩm)
| Hàm | Ý nghĩa & tham số |
|---|---|
| `sc.landscape(o)` | Phông núi rừng tô theo pixel (thay `sc.sky()+sc.treeline()`): bầu trời có mặt trời & mây, 4 lớp núi tan vào sương, mặt rừng nhìn từ trên cao (khi camera cao), bìa rừng gồm từng tán cây có viền ngược sáng và lỗ trời xuyên tán, hàng cây thứ hai mờ hơn phía sau. Có phản chiếu. `forestZ` (m, -1 = không có bìa rừng), `treeHeight`, `crown` (cỡ tán, m), `mist`, `fog`, `clouds`, `holes`, `mountains` (0..1.5, false), `mountainScale`, `mountainNear/mountainFar/forestColor/forestColor2/bank/haze` (màu), `res`, `blur` |
| `sun.rays` (trong `s.nature({sun})`) | Tia nắng thể tích (crepuscular rays) 0..1.5, bị tán lá/đá che tự nhiên. `sun.raysOpts: {threshold, decay, density, color}` |
| `sc.rocks([...])` | Đá suối dạng lưới 3D (WebGL): `{x, z, r, h, color, mossColor, seed, wet}`. Nước tự tạo cổ bọt quanh đá, vệt xoáy & sóng chữ V phía hạ lưu theo `flow`; đá được phản chiếu |
| `sc.foliage(o)` | Lá tiền cảnh mờ (bokeh) đung đưa theo gió, viền khung hình: `side:'left'|'right'|'top', depth (m), count, size, color, color2, reach, y, blur` |
| `sc.swallows(o)` | Đàn chim én (đập cánh nhanh xen lượn): `count, from:[x,y,z], to:[x,y,z], start, dur, spread, size, color, seed` |
| `sc.cutout(o)` | Ảnh cắt nền (PNG trong suốt: cây, bụi, đá thật) đặt thành tấm đứng tại `x, z` (m), uốn theo gió (gốc cứng, ngọn mềm, cơn giật tới theo mặt gió) và lá rung; có phản chiếu. `image` (tên chất liệu), `height`, `width`, `y`, `crop:[u0,v0,u1,v1]`, `sway`, `stiffness`, `flutter`, `exposure`, `tint`, `saturation`, `rim`, `flip`, `blur` |
| `sc.plate(o)` | Ảnh/ video thật làm phông xa (như `cutout` nhưng không lay): `image, x, z, y, height, width, crop, exposure, saturation`. Mặt nước tự phản chiếu ảnh |
| `sc.bottle(o)` | Chai nước PET trong suốt (WebGL): khúc xạ cảnh sau như thấu kính trụ, Fresnel, dải sáng, nhãn quấn trụ, nắp có gờ, màng hơi lạnh + giọt đọng (một số giọt chảy xuống để lại vệt). `x, y, z` (đáy chai, m), `height, radius, cap` (màu nắp), `fill` (mực nước 0..1), `frost`, `drops`, `tint`, `label:{name, subtitle, tagline, volume, color, color2}` hoặc `label:false` |

Ví dụ hoàn chỉnh TVC 30 giây: `examples/tvc-en-nam/` (`npm run seed:tvc`).

## Ảnh thật quay như phim — `s.photo(...)`
Biến một ảnh chụp thật thành cảnh quay: camera 2.5D có thị sai thật theo bản đồ độ sâu, nước chảy, cây lá lay theo gió, sương trôi, lấy nét theo độ sâu, tia nắng, chỉnh màu. Vẽ ngay và trả về đối tượng để đặt thêm vật thể bám theo ảnh.

Chuẩn bị chất liệu (một lần cho mỗi ảnh): `python3 scripts/photo/prep.py anh.jpg --name river --out <thư mục> --spec river.json` → `river.jpg`, `river.depth.png` (độ sâu Depth Anything V2), `river.mask.png` (R nước, G cây lay, B trời), `river.flow.png` (hướng chảy). Tải cả 4 file lên dự án với tên đúng như trên (`node scripts/seed-tvc-real.js <thư mục>` làm sẵn). Spec JSON vẽ vùng bằng đa giác toạ độ 0..1: `water:[{poly, spine | dir, speed}]`, `sway:[{poly, amount}]`, `sky:[{poly}]`, `autoSway`.

| Tham số | Ý nghĩa |
|---|---|
| `image` | Tên ảnh; tự tìm `<tên>.depth`, `<tên>.mask`, `<tên>.flow` (hoặc truyền `depth, mask, flowMap`) |
| `frame: {zoom, x, y}` | Khung cắt trong ảnh (tâm & độ phóng, toạ độ 0..1) |
| `camera: {zoom, dolly, truck:[x,y], pan:[x,y], roll, parallax, handheld}` | `dolly` đẩy vào (vật gần to nhanh hơn vật xa), `truck` trượt ngang/ dọc có thị sai, `pan` lia cứng, `handheld` 0..1 rung tay tự nhiên |
| `flow: {amount, rate, glint}` | Nước chảy theo bản đồ hướng (0.02–0.03 là vừa), lấp lánh trôi theo dòng |
| `sway: {amount, freq}` | Cây lá lay theo gió (`wind` như `s.nature`), mạnh lên khi có cơn giật |
| `fog: {amount, speed, scale, near, top, color}` | Mây sương trôi theo gió, dày theo khoảng cách; `top:1` chỉ ở nửa trên |
| `dof: {focus, aperture, max, focusAt:[u,v], focusMix}` | Độ sâu trường ảnh theo bản đồ độ sâu (0 xa … 1 gần). `focusAt` lấy nét đúng điểm trong ảnh; `focusMix` 0→1 để chuyển nét (rack focus) từ `focus` sang điểm đó |
| `rays: {x, y, amount, color}` | Tia nắng toả từ điểm (toạ độ màn hình 0..1) qua vùng trời/ vùng sáng |
| `grade: {exposure, temperature, saturation, contrast, shadows, highlights}` | Chỉnh màu (shadows/highlights là màu nhân, vd `'#e6f0ee'`) |
| `bloom, bloomThreshold` | Loé sáng quanh vùng sáng |
| `light: {x, y}`, `sunColor`, `sunIntensity` | Hướng & màu sáng cho vật thể đặt thêm |

Đối tượng trả về: `ph.toScreen(u, v)` → `[x, y]` px (bám theo camera), `ph.depthAt(u, v)`, `ph.drop({u, v | x, y, r, mode:'ball'|'pendant'|'sessile', stretch, beta, sx, sy})` (giọt nước như thấu kính thật), `ph.bottle({u, v | x, y, height, frost, drops, brightness, saturate, contrast, blur, sky, tint, label})` (chai sản phẩm đứng trên điểm ảnh, khớp màu & độ nét với cảnh).

Ví dụ hoàn chỉnh: `examples/tvc-en-nam-real/` (TVC 30 giây dựng từ ảnh thật).
