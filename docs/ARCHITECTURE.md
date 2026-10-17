# Kiến trúc

```
Trình duyệt (editor)                Server Node (Express)                 Chromium headless
┌───────────────────────┐   REST   ┌───────────────────────────┐  page   ┌─────────────────────┐
│ public/app/*  (UI)    │ ───────▶ │ server/index.js  (API)    │ ──────▶ │ public/render.html  │
│ engine/*  (preview)   │          │ store.js  (file-based)    │         │ engine/* (cùng code)│
└───────────────────────┘          │ director.js ── Claude API │         └─────────┬───────────┘
                                   │ render.js  ── ffmpeg      │ ◀── JPEG frames ──┘
                                   │ jobs.js, tts.js, templates│
                                   └───────────────────────────┘
```

## Nguyên tắc

1. **Shot là code, engine dùng chung.** Editor và bản xuất chạy *cùng một* `engine/`. Những gì thấy khi xem trước chính là những gì được render.
2. **Tất định.** Mọi mô phỏng là hàm thuần của thời gian `t`: lò xo, rơi nảy giải tích; hạt (giọt bắn, mảnh vỡ) được tích phân một lần ở 240 Hz rồi cache và lấy mẫu theo `t`. Nhờ vậy tua, xuất song song nhiều luồng, contact sheet đều cho kết quả giống hệt.
3. **Vật liệu điều khiển cả vật lý lẫn quang học.** `engine/materials.js`: độ nhớt, sức căng bề mặt, mật độ → số gai vương miện, kích thước giọt, tốc độ lan; màu thân/lõi/viền, độ trong, độ bóng, tán xạ → cách vẽ giọt (truyền sáng, caustic, Fresnel, specular).
4. **AI tự kiểm chứng.** Đạo diễn không chỉ sinh code: server render thử từng shot, bắt lỗi runtime, đo số liệu QA (khung đen/trống, chữ ngoài vùng an toàn, ms/khung), gửi contact sheet ảnh thật cho Claude tự duyệt và sửa (tối đa 3 vòng). Shot vẫn lỗi runtime ở vòng cuối không bao giờ ghi đè bản đang chạy được.

## Engine (`engine/`)

| File | Vai trò |
|---|---|
| `engine.js` | Biên dịch shot, dựng API `s` mỗi khung, camera + thị sai theo depth, layer, chuyển cảnh, motion blur (tích luỹ nhiều mẫu trong 1 khung), đồng bộ video. Trường sửa được: `s.field` đọc `shot.fields`, ghi lại khai báo; `engine.fieldsOf(shotId)` trả danh sách field (tự chạy shot một lần ở t=0 nếu code mới đổi) cho Inspector |
| `math.js` | easing, RNG có seed, nhiễu mượt, lò xo giải tích, rơi–nảy theo hệ số đàn hồi, con lắc |
| `materials.js` | preset vật liệu + `drawDroplet` (truyền sáng, caustic, viền Fresnel, highlight, kéo giãn theo vận tốc) |
| `fx/sim.js` | bộ mô phỏng hạt: trọng lực, lực cản, gió, nhiễu loạn, va sàn (nảy/hấp thụ/dính), sinh sự kiện va chạm |
| `fx/liquid.js` | giọt rơi → vương miện (thành mỏng hình tulip, gai Rayleigh–Plateau thắt cổ thành giọt, bụi nước) → sụp → tia Worthington → gợn sóng mao dẫn; rót chất lỏng; giọt nhỏ giọt |
| `fx/atmosphere.js` | bokeh, bụi, khói/hơi nước, bọt khí (định luật Stokes), caustics, tia sáng thể tích, sheen thuỷ tinh, lens flare, light leak, burst hạt vật lý |
| `fx/text.js` | chữ động tiếng Việt (*nhấn màu*), underline, badge, icon |
| `fx/nature.js` | cảnh thiên nhiên 3D: camera pinhole (mét), phối cảnh, độ sâu trường ảnh, phản chiếu phẳng, thứ tự vẽ |
| `fx/wind.js` | trường gió dùng chung: gió giật lan theo mặt trước gió, nhiễu loạn "đóng băng" trôi theo gió (JS + GLSL giống hệt) |
| `fx/water.js` | mặt nước WebGL2: sóng gió có tán sắc mao dẫn–trọng lực, mô phỏng trường độ cao (phương trình sóng + số hạng song điều hoà), Fresnel, khúc xạ đáy sỏi + caustics, lấp lánh mặt trời |
| `fx/foliage.js` | lá rơi theo mô hình tấm mỏng khí động học (Andersen–Pesavento–Wang), cỏ lau là dao động tắt dần chịu lực cản gió |
| `fx/dew.js`, `fx/leafgl.js` | lá chính + giọt sương (ghim/ trượt/ gom/ treo/ rơi), shader lá theo pixel (gân lá, xuyên sáng, sáp bóng) |
| `post.js` | grade màu, bloom, vignette, hạt phim, letterbox |

## Server (`server/`)

- `store.js` — mỗi dự án là một thư mục `data/projects/<id>/` gồm `project.json`, `assets/`, `exports/`, `history/` (snapshot trước mỗi thay đổi lớn).
  - `project.brief` — brief có cấu trúc `{ subject, message, moods[], duration, aspect, cta, notes }` (sản phẩm/sự kiện, thông điệp, cảm xúc ≤ 8, thời lượng giây 3–180, `16:9|9:16|1:1|4:5`, CTA, ghi chú tự do). `normalizeBrief()` chạy mỗi lần load/save: bỏ khoá lạ và trường trống, trim + giới hạn độ dài; brief cũ dạng chuỗi → `{ notes }`. `PUT /api/projects/:id` đổi brief → snapshot lý do `brief` (bản trước khi sửa), gộp theo phiên: bỏ qua nếu snapshot mới nhất đã là `brief` và < 2 phút (`BRIEF_SNAPSHOT_GAP_MS`). UI migrate một lần `sessionStorage['brief:'+id]` → `notes` (xoá khoá sau khi lưu thành công).
- `render.js` — mở N trang Chromium (CPU raster), gọi `window.__frame(t, samples)`, nhận JPEG, sắp xếp lại thứ tự, đẩy vào ffmpeg (x264), sau đó trộn nhạc (fade, offset) + lồng tiếng (adelay) và mux.
- `director.js` — Claude nhận: tài liệu SHOT API + ví dụ, ảnh chất liệu (vision), JSON dự án, nhiệm vụ. Brief của dự án đi trong user turn mở đầu dưới dạng một khối `BRIEF` JSON gọn (`compactBrief`, trường trống đã bỏ) ngay trước khối `NHIỆM VỤ` — không đổi system prompt hay tool schema nên cache prefix ổn định, không thêm lượt gọi. Route `POST /api/projects/:id/director` nhận `brief` là object (lưu vào dự án trước, snapshot `brief` nếu khác) hoặc chuỗi (tương thích cũ = yêu cầu sửa) và `request` (yêu cầu sửa lần này); job chỉ lưu `{ request, shotId, review }`, brief đọc lại từ dự án khi job chạy. Trả kết quả qua tool có schema (`submit_cut` / `submit_shot`). Sau đó: kiểm tra cú pháp → render thử headless → phản hồi lỗi / contact sheet → sửa. Prompt caching: breakpoint `cache_control` ở khối system và khối cuối của user turn mở đầu (thứ tự khối cố định) nên các vòng sửa đọc lại prefix từ cache; token mỗi lượt ghi vào log job và `project.lastDirector.usage`.
- `qa.js` — QA đo được cho vòng tự kiểm của đạo diễn. `window.__inspect` (`public/render-page.js`) lấy mẫu 3 thời điểm/shot: thống kê độ sáng của buffer shot *trước* hậu kỳ (TB, độ lệch chuẩn, tỉ lệ pixel sáng), ms/khung (đồng hồ do `render.js` tiêm qua `window.__profNow` — engine và trang render không đọc đồng hồ thật), khung chữ của mọi `s.text` (hook nội bộ `engine.textProbe`, chỉ đọc layout nên không đổi pixel). `qaIssues()` đổi thành lỗi theo ngưỡng đặt tên (đen, trống, chữ ngoài safe-area 6%, > 500 ms/khung, throw) → text tiếng Việt trong feedback. Vòng cuối shot còn throw/lỗi cú pháp → `guardFailedShots()` khôi phục code chạy được gần nhất (vòng trước hoặc bản trước khi gọi đạo diễn) và gắn `shot.needsReview = { reason, at }` (chuẩn hoá trong `store.js`; tự xoá khi code shot đổi — `PUT /api/projects/:id` và editor); timeline hiện huy hiệu "⚠ Cần xem lại".
- `templates.js` — cảnh mẫu & công thức (cũng là ví dụ few-shot cho đạo diễn).
- `jobs.js` — hàng đợi job bền vững. Job là dữ liệu thuần (`kind` + `params` + trạng thái/tiến độ/log/kết quả), lưu ở `data/jobs/<id>.json` (ghi tmp + rename; đổi trạng thái ghi ngay, tiến độ/log gộp ~1 s). Khởi động lại: job `running`/`queued` → `interrupted` (giữ log), "Chạy lại" tạo job mới từ `kind` + `params`. Làn chạy: `render` tuần tự, `director` tối đa `DIRECTOR_CONCURRENCY` (mặc định 2), phần vượt chờ FIFO; huỷ được job đang chờ. Mọi thay đổi phát qua `jobEvents` → SSE (`/api/jobs/:id/events`, `/api/projects/:id/jobs/events`, heartbeat 15 s); UI dùng `EventSource`, lỗi thì quay về poll. Job xong quá 6 giờ bị dọn khỏi RAM và đĩa.
- `job-kinds.js` — các loại job (`director`, `render`; `test-*` chỉ khi `JOBS_TEST_KINDS=1` cho `scripts/test-jobs.js`). Job render đọc lại dự án lúc bắt đầu chạy (`loadForRender`) và ghi `projectUpdatedAt`.

## Mở rộng tiếp theo (gợi ý)

- **Plate video AI cho cảnh cần vật lý phức tạp hơn** (vải, tóc, khói dày, chất lỏng 3D thật): thêm một loại chất liệu "plate" sinh bởi mô hình image-to-video (Seedance/Kling/Veo) rồi dùng `s.video()` làm nền — lớp code vẫn đảm bảo chữ, logo, màu thương hiệu chính xác. API `s.video` đã sẵn sàng.
- Mô phỏng chất lỏng 2D SPH/FLIP trên WebGL cho cảnh rót/khuấy cận cảnh.
- Lộ trình nâng cấp độ chân thực: xem [REALISM_PLAN.md](REALISM_PLAN.md).
- Mẫu thương hiệu (brand kit) dùng chung giữa các dự án.
- Hàng đợi render phân tán nhiều máy.
