# Ennam Motion Studio

Phần mềm nội bộ cho team marketing tạo **motion video từ prompt + hình ảnh**.
Mỗi shot là **code chuyển động** chạy trên engine canvas có mô phỏng vật lý
(chất lỏng, trọng lực, va chạm, lò xo, khói, bọt, khúc xạ…). Đạo diễn AI (Claude)
xem chất liệu, viết code từng shot, **render thử và tự duyệt** contact sheet trước khi giao.
Xuất MP4 bằng Chromium headless + ffmpeg, có motion blur, nhạc và lồng tiếng.

![layout](docs/layout.png)

## Chạy nhanh

```bash
npm install
npx playwright install chromium        # nếu máy chưa có Chromium (hoặc đặt CHROME_PATH)
cp .env.example .env                   # điền ANTHROPIC_API_KEY để bật Đạo diễn AI
npm start                              # http://localhost:5173
npm run seed                           # (tuỳ chọn) tạo dự án demo "Lumi C+"
npm run seed:nature                    # (tuỳ chọn) demo vật lý thiên nhiên: gió, lá rơi, nước chảy, giọt sương
npm run seed:tvc                       # (tuỳ chọn) TVC 30s Én Nam (xem docs/TVC_EN_NAM.md)
npm run library -- --provider pexels --query "forest stream" --type video   # tải chất liệu có giấy phép (library/sources.json)
pip install -r scripts/requirements.txt   # (tuỳ chọn) cho scripts/photo/prep.py và scripts/audio/*
```

Yêu cầu: Node ≥ 20, `ffmpeg`/`ffprobe` trong PATH.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `ANTHROPIC_API_KEY` | Bật Đạo diễn AI |
| `DIRECTOR_MODEL` | Mặc định `claude-opus-5-5` |
| `DIRECTOR_PROMPT_CACHE` | Prompt caching cho đạo diễn (mặc định bật); đặt `0` để tắt khi đo đối chứng |
| `DIRECTOR_CONCURRENCY` | Số job đạo diễn chạy đồng thời (mặc định 2); job vượt giới hạn xếp hàng FIFO. Render luôn chạy từng job một |
| `JOBS_TEST_KINDS` | Chỉ dùng cho `scripts/test-jobs.js` (`1` = bật kind job giả và `POST /api/test/jobs`); không bật trên server thật |
| `APP_PASSWORD` | Bật đăng nhập Basic Auth cho cả team (user bất kỳ, mật khẩu này) |
| `PORT` | Mặc định 5173 |
| `DATA_DIR` | Nơi lưu dự án, chất liệu, video xuất (mặc định `./data`) |
| `RENDER_WORKERS` | Số trang Chromium render song song (mặc định = số nhân − 1) |
| `CHROME_PATH` | Đường dẫn Chromium nếu không dùng bản của Playwright |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | Giọng đọc AI (tiếng Việt tốt) — tuỳ chọn |
| `OPENAI_API_KEY` | TTS thay thế qua `/audio/speech` — tuỳ chọn |
| `PEXELS_API_KEY` | Tải chất liệu có giấy phép từ Pexels qua `npm run library` — tuỳ chọn |
| `PIXABAY_API_KEY` | Tải chất liệu có giấy phép từ Pixabay qua `npm run library` — tuỳ chọn |

## Giao diện

- **Đạo diễn AI** — form **Brief** có cấu trúc (sản phẩm/sự kiện, thông điệp chính, cảm xúc dạng chip chọn nhiều + tự nhập, thời lượng, kênh/tỉ lệ khung, CTA, ghi chú tự do) lưu cùng dự án (`project.brief`, tự lưu như mọi chỉnh sửa, có trong Lịch sử, mở từ máy khác vẫn còn); khi đã có shot thêm ô *Yêu cầu sửa lần này* → Claude dựng/sửa cả video; Contact sheet; Xuất MP4; danh sách bản đã xuất; Storyboard. Brief cũ chỉ nằm trong `sessionStorage` của trình duyệt được tự chuyển vào *Ghi chú tự do* một lần khi mở dự án.
- **Nhanh** — dựng ngay từ công thức (Quảng cáo sản phẩm, Teaser, Recap sự kiện) không cần AI.
- **Mẫu cảnh** — chèn cảnh mẫu (giọt rơi vương miện, rót chất lỏng, sản phẩm rơi nảy, bùng nổ thành phần, 3 lợi ích, CTA, Ken Burns).
- **Media** — tải ảnh/video/nhạc. Đặt tên & mô tả để đạo diễn hiểu vai trò. PNG nền trong suốt cho sản phẩm.
- **Lồng tiếng** — câu thoại trên timeline, tạo giọng AI hoặc tải thu âm.
- **Nhạc** — nhạc nền, âm lượng, fade.
- **Phong cách** — grade màu, vignette, bloom, hạt phim, letterbox, bảng màu thương hiệu, khung hình (16:9, 9:16, 1:1, 4:5, 4K), fps.
- **Cột phải** — thuộc tính shot, chuyển cảnh, mục **Nội dung** (form tự sinh từ các `s.field` của shot: chữ, màu, số, ảnh từ Chất liệu; gõ là xem trước đổi ngay, không gọi AI; *Về mặc định* bỏ giá trị đã sửa), *Nhờ đạo diễn* cho riêng shot, sửa code trực tiếp (xem trước cập nhật ngay).
- **Timeline** — kéo mép phải shot đổi độ dài, kéo shot đổi thứ tự, kéo câu thoại để dời, bấm thước để tua.
- **Job** (tab Đạo diễn AI) — tiến độ đạo diễn/xuất video cập nhật tức thì qua SSE (tự chuyển sang poll nếu SSE lỗi); huỷ được cả job đang chờ. Job lưu ở `DATA_DIR/jobs/`, nên khi server khởi động lại giữa chừng job hiện **⚠️ gián đoạn** kèm log cũ và nút **↻ Chạy lại**.
- **Lịch sử** — mọi lần AI/mẫu thay đổi và mỗi phiên sửa brief (*Trước khi sửa brief*, gộp các lần gõ cách nhau < 2 phút) đều lưu phiên bản cũ, khôi phục 1 chạm.

Phím tắt: `Space` phát/dừng · `←/→` từng khung (`Shift` = 1 giây) · `Home` về đầu · `Ctrl/⌘+S` lưu.

## Đóng góp

Mở PR vào `main`; CI (`.github/workflows/ci.yml`) chạy `npm run check` — PR chỉ được merge khi CI xanh. Merge bằng squash.

## Kiến trúc

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) và API viết shot ở [docs/SHOT_API.md](docs/SHOT_API.md).

## Script dev

```bash
npm run check                                    # quality gate (cũng chạy trên CI cho mỗi PR)
node scripts/sheet.js <projectId> out.jpg 3     # contact sheet render thật
node scripts/frame.js <projectId> <shot> 0.5,1.2 out   # khung full-res của 1 shot
node scripts/bench.js <projectId> 3              # đo thời gian render từng shot
node scripts/ui-shot.js "#p=<projectId>"         # chụp giao diện
node scripts/test-jobs.js                        # test hàng đợi job: restart → interrupted, giới hạn song song, huỷ, render đọc project lúc chạy, SSE (tự bật server con)
node scripts/test-director-cache.js              # test offline: cache_control + cộng dồn token của đạo diễn (không gọi API)
node scripts/test-brief.js                       # test offline brief có cấu trúc: chuẩn hoá, JSON gọn gửi đạo diễn (stub client), snapshot "brief" + khôi phục (tự bật server con)
node scripts/test-qa.js                          # QA đo được: 5 shot cố ý lỗi phải bị phát hiện + guard vòng cuối (mock, không gọi API)
node --env-file=.env scripts/director-bench.js   # đo token đạo diễn có/không cache trên 3 brief mẫu (tốn phí API thật)
```

`director-bench.js` cần `ANTHROPIC_API_KEY` và server đang chạy; nếu chưa có dự án demo "Lumi C+ (demo)" nó tự chạy `scripts/seed-demo.js`.
Mặc định mỗi brief chạy 2 lần (không cache rồi có cache) và in bảng markdown 4 trường token + % thay đổi chi phí input quy đổi
(`input + 1.25 × cache write + 0.1 × cache read`). Tuỳ chọn: `--n 1..3` số brief, `--no-cache` chỉ chạy bản tắt breakpoint,
`--cache-only` chỉ chạy bản có cache, `--project <id>` dùng dự án khác. Token của lần chạy gần nhất được lưu ở
`project.lastDirector.usage` (`total` + `rounds`) và hiện ở tab Đạo diễn AI.

### API job

| Route | Ý nghĩa |
|---|---|
| `GET /api/jobs?project=<id>` · `GET /api/jobs/:id` | Trạng thái job: `queued` → `running` → `done` / `error` / `cancelled`, hoặc `interrupted` (server khởi động lại khi job đang chạy/chờ) |
| `POST /api/jobs/:id/cancel` | Huỷ job đang chạy hoặc đang chờ (job chờ bị huỷ không bao giờ chạy) |
| `POST /api/jobs/:id/retry` | "Chạy lại": tạo job mới cùng `kind` + `params` (trường `retryOf` trỏ về job cũ) |
| `GET /api/jobs/:id/events` | SSE: `event: job` (JSON job đầy đủ) mỗi khi đổi trạng thái/tiến độ; tự đóng khi job kết thúc; heartbeat `: ping` mỗi 15 s |
| `GET /api/projects/:id/jobs/events` | SSE theo dự án: `event: jobs` (danh sách ban đầu) rồi `event: job` cho mọi job của dự án |

Job render đọc lại dự án **lúc bắt đầu chạy** (không phải lúc bấm xuất) và ghi `projectUpdatedAt` của bản đã dùng. Nếu đặt sau reverse proxy, tắt buffering cho `/api/*/events` (server đã gửi `X-Accel-Buffering: no`).

### Golden-frame (kiểm tra hình ảnh tự động)

`npm run check` render các fixture trong `test/golden/fixtures/` (chất lỏng, chữ tiếng Việt, `s.photo` với ảnh/depth/mask/flow tổng hợp, thiên nhiên WebGL, hậu kỳ) ở scale 0.25 và so với ảnh trong `test/golden/expected/`:

- **Khớp ảnh** — pixel lệch > 8/255 bị tính là sai; quá 0.1% số pixel → FAIL. Ảnh `*.actual.png`, `*.expected.png`, `*.diff.png` (đỏ = lệch quá ngưỡng, vàng = lệch nhỏ) ở `test/golden/out/` (CI tải lên artifact `golden-diff`).
- **Tất định** — mỗi khung render 2 lần ở 2 trang mới → phải giống hệt từng bit. Lần thứ 3 theo thứ tự ngược chỉ cảnh báo.
- **Hiệu năng** — ms/khung (đã chuẩn hoá theo một bài đo cố định của máy) so với `test/golden/expected/perf.json`; chậm hơn > 30% → FAIL trên CI, local chỉ WARN.

Chromium được cố định bằng devDependency `@sparticuz/chromium` (phiên bản khóa trong `package-lock.json`, chỉ Linux x64) để máy dev và CI raster giống nhau; font fallback dùng bộ font đi kèm gói.

```bash
node scripts/golden.js                 # chỉ chạy golden
node scripts/golden.js --only liquid,text
node scripts/golden.js --update        # thay đổi hình ảnh CÓ CHỦ ĐÍCH: ghi lại ảnh golden + baseline hiệu năng, commit kèm PR
SKIP_GOLDEN=1 npm run check            # bỏ qua golden khi chạy local (không được phép trên CI)
node test/golden/fixtures/make-assets.js   # sinh lại ảnh tổng hợp cho fixture s.photo
```

Thêm fixture: tạo `test/golden/fixtures/<tên>.json` (project JSON như `data/projects/<id>/project.json`, chất liệu đặt ở `fixtures/assets/`, khung cần chụp ở `golden.frames: [{ t, motionBlur }]`) rồi chạy `--update`. Biến tinh chỉnh: `GOLDEN_PIXEL_THRESHOLD`, `GOLDEN_MAX_RATIO`, `GOLDEN_PERF_TOLERANCE`, `GOLDEN_SCALE`.

### QA đo được của đạo diễn (`scripts/test-qa.js`)

Khi đạo diễn AI render thử, `window.__inspect` trả thêm số liệu mỗi shot ở 3 thời điểm cố định (độ sáng TB, độ lệch chuẩn độ sáng, ms/khung, khung chữ của `s.text`); `server/qa.js` đổi thành lỗi: khung đen/gần đen, khung trống một màu, chữ ra ngoài vùng an toàn 6%, > 500 ms/khung, lỗi runtime — gửi cho đạo diễn dạng text để tự sửa (ngưỡng là hằng số đặt tên ở đầu `server/qa.js`). Vòng cuối shot vẫn lỗi runtime → giữ code cũ chạy được và gắn cờ **⚠ Cần xem lại** trên timeline (`shot.needsReview`); cờ tự bỏ khi sửa code shot.

`npm run check` chạy `node scripts/test-qa.js` sau golden: render 5 shot cố ý lỗi trong `test/qa/shots/` (mỗi file mở đầu `// expect: <loại lỗi>`) + 1 shot lành qua đúng đường inspect của đạo diễn (Chromium cố định, server tạm) và yêu cầu phát hiện 100%, shot lành không bị báo; kèm test mock đạo diễn (stub client Anthropic) cho guard vòng cuối. Chỉ Linux x64 như golden.

