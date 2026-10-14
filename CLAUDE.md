# Ennam Motion Studio — ghi chú cho Claude Code

- Node ESM, không có bước build. UI: `public/app/*` (vanilla JS modules). Engine dùng chung: `engine/*` (chạy trong trình duyệt, KHÔNG import Node API).
- Shot code là thân hàm nhận `s`; tài liệu chuẩn ở `docs/SHOT_API.md` — file này cũng được nhúng vào system prompt của đạo diễn AI, nên khi thêm/sửa API của engine PHẢI cập nhật nó.
- Mọi hiệu ứng phải tất định theo `t` (không Math.random/Date). Hạt dùng `fx/sim.js` (cache theo key).
- Kiểm tra trực quan sau khi sửa engine: `node scripts/frame.js <id> <shot> 0.5,1.5 /tmp/f` hoặc `node scripts/sheet.js <id> /tmp/s.jpg`. Đo tốc độ: `node scripts/bench.js <id>`.
- Render headless dùng CPU raster (`--disable-gpu`), nhanh hơn swiftshader ~7 lần. Tránh `ctx.filter = blur()` trên vùng lớn mỗi khung — dùng đường downscale như trong `drawMedia`.
- Server cần đang chạy (`npm start`) cho các script trên vì trang render tải engine qua HTTP.
