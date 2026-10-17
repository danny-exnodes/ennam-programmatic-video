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
| `APP_PASSWORD` | Mật khẩu chung cũ (Basic Auth, user bất kỳ). Khi chưa có tài khoản: bắt buộc cho cả team. Khi đã có tài khoản: còn được chấp nhận 30 ngày rồi bị bỏ — xem [Tài khoản](#tài-khoản--đăng-nhập) |
| `COOKIE_SECURE` | `1` = cookie phiên luôn có cờ `Secure`; bỏ trống = tự bật khi request qua HTTPS hoặc `X-Forwarded-Proto: https` |
| `TRUST_PROXY` | Đặt khi chạy sau reverse proxy / Cloudflare Tunnel (vd. `loopback` hoặc `1`) để rate limit đăng nhập theo IP thật (giá trị `trust proxy` của Express) |
| `AUTH_CACHE_MS` | Thời gian cache `users.json` (mặc định 30000 ms): khoá/sửa tài khoản từ bên ngoài server có hiệu lực trong khoảng này |
| `EMS_TOKEN` | Token cá nhân `ems_…` cho script dev chạy ở process riêng (`frame.js`, `sheet.js`, `bench.js`) khi server đã bật tài khoản |
| `PORT` | Mặc định 5173 |
| `DATA_DIR` | Nơi lưu dự án, chất liệu, video xuất (mặc định `./data`) |
| `RENDER_WORKERS` | Số trang Chromium render song song (mặc định = số nhân − 1) |
| `CHROME_PATH` | Đường dẫn Chromium nếu không dùng bản của Playwright |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | Giọng đọc AI (tiếng Việt tốt) — tuỳ chọn |
| `OPENAI_API_KEY` | TTS thay thế qua `/audio/speech` — tuỳ chọn |
| `PEXELS_API_KEY` | Tải chất liệu có giấy phép từ Pexels qua `npm run library` — tuỳ chọn |
| `PIXABAY_API_KEY` | Tải chất liệu có giấy phép từ Pixabay qua `npm run library` — tuỳ chọn |

## Tài khoản & đăng nhập

Mỗi người đăng nhập bằng tài khoản riêng (lưu ở `DATA_DIR/users.json`); Lịch sử, job và token đạo diễn AI gắn với người thực hiện.

```bash
npm run user:add -- danny --admin --name "Danny"     # tạo admin đầu tiên (hỏi mật khẩu, không hiện ký tự)
echo "$PW" | npm run user:add -- lananh --name "Lan Anh" --password-stdin   # cho script cài đặt
```

- **Đăng nhập** ở `/login.html` → cookie phiên (HttpOnly, SameSite=Lax, 14 ngày, tự gia hạn khi dùng; phiên lưu phía server ở `DATA_DIR/sessions/`). Sai quá 10 lần / 15 phút / IP bị chặn tạm.
- **Tài khoản** (nút trên thanh trên cùng): đổi mật khẩu, xem token đạo diễn đã dùng trong tháng, tạo / thu hồi **API token cá nhân** (`Authorization: Bearer ems_…`, dùng cho script hoặc app mobile). Token chỉ hiện một lần khi tạo; server chỉ lưu SHA-256.
- **Quản trị** (admin): thêm tài khoản, khoá / mở khoá, đặt lại mật khẩu, xem token đạo diễn AI theo người theo tháng. Khoá một người → phiên và token của người đó bị từ chối ngay (sửa `users.json` từ ngoài: trong `AUTH_CACHE_MS`, mặc định 30 s).
- Usage đạo diễn ghi ở job (`job.usage`, `job.userId`) và cộng dồn vào `DATA_DIR/usage/<YYYY-MM>.jsonl` (`{ at, userId, projectId, jobId, usage }`, không có brief hay secret) — job bị dọn sau 6 giờ nhưng log tháng thì giữ.
- Dữ liệu trước khi có tài khoản (snapshot Lịch sử, job không có `userId`) vẫn hiển thị, người thực hiện là **"không rõ"**.

**Chuyển tiếp từ `APP_PASSWORD`:**

| Trạng thái | Đăng nhập |
|---|---|
| Chưa có tài khoản, không đặt `APP_PASSWORD` | Không yêu cầu (như trước) |
| Chưa có tài khoản, có `APP_PASSWORD` | Basic Auth mật khẩu chung như cũ + banner "Hãy tạo tài khoản admin" |
| Đã có ≥ 1 tài khoản | Phiên / token. `APP_PASSWORD` vẫn vào được thêm **30 ngày** kể từ lúc tạo tài khoản đầu tiên (`firstUserAt` trong `users.json`) kèm header `X-Auth-Warning`, cảnh báo trong log và banner; trang login có link "dùng mật khẩu chung cũ". Hết 30 ngày → bị từ chối |

`/review/*` và tài nguyên của trang login nằm ngoài đăng nhập. Trang render headless của server dùng một token nội bộ ngẫu nhiên theo process (chỉ nhận từ loopback); script dev chạy riêng (`frame.js`, `sheet.js`, `bench.js`) cần `EMS_TOKEN` khi server đã có tài khoản.

## Giao diện

- **Đạo diễn AI** — viết brief → Claude dựng/sửa cả video; Contact sheet; Xuất MP4; danh sách bản đã xuất; Storyboard.
- **Nhanh** — dựng ngay từ công thức (Quảng cáo sản phẩm, Teaser, Recap sự kiện) không cần AI.
- **Mẫu cảnh** — chèn cảnh mẫu (giọt rơi vương miện, rót chất lỏng, sản phẩm rơi nảy, bùng nổ thành phần, 3 lợi ích, CTA, Ken Burns).
- **Media** — tải ảnh/video/nhạc. Đặt tên & mô tả để đạo diễn hiểu vai trò. PNG nền trong suốt cho sản phẩm.
- **Lồng tiếng** — câu thoại trên timeline, tạo giọng AI hoặc tải thu âm.
- **Nhạc** — nhạc nền, âm lượng, fade.
- **Phong cách** — grade màu, vignette, bloom, hạt phim, letterbox, bảng màu thương hiệu, khung hình (16:9, 9:16, 1:1, 4:5, 4K), fps.
- **Cột phải** — thuộc tính shot, chuyển cảnh, mục **Nội dung** (form tự sinh từ các `s.field` của shot: chữ, màu, số, ảnh từ Chất liệu; gõ là xem trước đổi ngay, không gọi AI; *Về mặc định* bỏ giá trị đã sửa), *Nhờ đạo diễn* cho riêng shot, sửa code trực tiếp (xem trước cập nhật ngay).
- **Timeline** — kéo mép phải shot đổi độ dài, kéo shot đổi thứ tự, kéo câu thoại để dời, bấm thước để tua.
- **Job** (tab Đạo diễn AI) — tiến độ đạo diễn/xuất video cập nhật tức thì qua SSE (tự chuyển sang poll nếu SSE lỗi); huỷ được cả job đang chờ. Job lưu ở `DATA_DIR/jobs/`, nên khi server khởi động lại giữa chừng job hiện **⚠️ gián đoạn** kèm log cũ và nút **↻ Chạy lại**.
- **Lịch sử** — mọi lần AI/mẫu thay đổi đều lưu phiên bản cũ, khôi phục 1 chạm; mỗi bản ghi tên người thực hiện (bản cũ: "không rõ"). Danh sách job cũng hiện tên người tạo job.
- **Tài khoản / Quản trị / Đăng xuất** — góc phải thanh trên cùng (khi server đã có tài khoản), xem [Tài khoản](#tài-khoản--đăng-nhập).

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
node scripts/test-auth.js                        # test tài khoản: 401, đăng nhập, rate limit, chuyển tiếp APP_PASSWORD, khoá user, token băm, userId trên job/lịch sử (tự bật server con)
node scripts/test-jobs.js                        # test hàng đợi job: restart → interrupted, giới hạn song song, huỷ, render đọc project lúc chạy, SSE (tự bật server con)
node scripts/test-director-cache.js              # test offline: cache_control + cộng dồn token của đạo diễn (không gọi API)
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
| (mọi job) | `userId` người tạo (null = job cũ / không đăng nhập) + `userName` tên hiển thị; job đạo diễn xong có `usage` (tổng 4 trường token) |
| `GET /api/jobs/:id/events` | SSE: `event: job` (JSON job đầy đủ) mỗi khi đổi trạng thái/tiến độ; tự đóng khi job kết thúc; heartbeat `: ping` mỗi 15 s |
| `GET /api/projects/:id/jobs/events` | SSE theo dự án: `event: jobs` (danh sách ban đầu) rồi `event: job` cho mọi job của dự án |

Job render đọc lại dự án **lúc bắt đầu chạy** (không phải lúc bấm xuất) và ghi `projectUpdatedAt` của bản đã dùng. Nếu đặt sau reverse proxy, tắt buffering cho `/api/*/events` (server đã gửi `X-Accel-Buffering: no`).

### API tài khoản

| Route | Ý nghĩa |
|---|---|
| `POST /api/auth/login` `{ username, password }` · `POST /api/auth/logout` | Đăng nhập (đặt cookie `ems_session`) / đăng xuất |
| `GET /api/auth/status` | `{ mode: open\|legacy\|accounts, via, user, banner, transitionEndsAt }` (công khai) |
| `GET/POST /api/account/tokens` · `DELETE /api/account/tokens/:id` | Token cá nhân: liệt kê / tạo (trả token gốc một lần) / thu hồi |
| `POST /api/account/password` `{ current, password }` · `GET /api/account/usage?month=YYYY-MM` | Đổi mật khẩu (đăng xuất các phiên khác) · usage của mình |
| `GET/POST /api/admin/users` · `PATCH /api/admin/users/:id` `{ status, role, name }` · `POST /api/admin/users/:id/password` | Admin: tài khoản, khoá/mở, đặt lại mật khẩu |
| `GET /api/admin/usage?month=YYYY-MM` | Admin: token đạo diễn theo người trong tháng (`rows[]`, `months[]`) |

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

