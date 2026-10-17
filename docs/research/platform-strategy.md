# Nghiên cứu: Claude Platform, Higgsfield & app mobile cho Ennam Motion Studio

> Tài liệu tham khảo, **không phải spec đã duyệt**. Tổng hợp ngày 2026-10-14 → 2026-10-17, đối chiếu với `main` tại commit `609c78b`.
> Giá, credit và trạng thái beta thay đổi nhanh — kiểm tra lại link nguồn trước khi ra quyết định chi phí.

## 1. Tóm tắt cho team

- **Giữ kiến trúc hiện tại làm lõi.** Engine tất định + đạo diễn AI viết shot code đảm bảo chữ, logo, màu thương hiệu chính xác. Higgsfield nên vào như **nguồn "plate" video** (đúng hướng gợi ý trong `docs/ARCHITECTURE.md`), không thay engine.
- **Tiết kiệm credit Claude ngay, không đổi hành vi:** `server/director.js` gửi `systemPrompt()` (nhúng toàn bộ `SHOT_API.md` + ví dụ) ở mọi lượt, kể cả vòng tự duyệt tối đa 3 lần, nhưng chưa dùng `cache_control`. Bật prompt caching là việc nhỏ, lợi lớn.
- **Chi phí lớn nhất khi thêm plate AI là credit Higgsfield**, không phải Claude. Mọi lệnh sinh phải đi qua một điểm có chốt chặn ngân sách.
- **App mobile:** App integrations (App Attest) trên Console chỉ cho iOS/macOS, đang beta, token chỉ gọi Messages API. Dùng cho phần chat nhẹ; pipeline và secret ở lại server.
- **Managed Agents** (Agents / Environments / Deployments trên Console) thay được phần lớn hạ tầng agent tự viết cho workflow multi-agent dài hạn, nhưng còn beta và không đủ điều kiện ZDR.

## 2. Claude Console vs Claude API

Cùng một dịch vụ, chung tài khoản và credit. API là nơi request chạy và trừ tiền; Console là giao diện quản lý: API key, workspace, billing, giới hạn chi tiêu, thống kê usage, Workbench (chạy prompt trong Workbench **cũng trừ credit**), App integrations.

Lưu ý: gói claude.ai (Team, Max) của team dev **tách hoàn toàn** khỏi credit API. Chi phí đạo diễn AI (`ANTHROPIC_API_KEY`) tính trên Console.

**Đề xuất:** tạo workspace riêng cho Motion Studio, đặt spending limit, dùng key riêng cho dev/staging/production để đọc usage theo môi trường.

## 3. Tận dụng credit Claude

Credit dùng thử của Console nhỏ, chỉ đủ PoC. Nguồn lớn hơn là Claude Startup Program (đang nộp hồ sơ) — số liệu chi phí/video từ PoC là bằng chứng tốt cho hồ sơ.

| Việc | Model gợi ý | Cách tiết kiệm |
| --- | --- | --- |
| Đạo diễn viết shot code (`submit_cut` / `submit_shot`) | `claude-opus-5-5` (hiện tại, `DIRECTOR_MODEL`) | **Prompt caching** cho system prompt (SHOT_API + ví dụ few-shot) |
| Vòng tự duyệt contact sheet | Cân nhắc `claude-sonnet-5-5` | Đo chất lượng trước khi đổi — đổi model cần Danny duyệt |
| Chuẩn hoá brief, tách shot, kiểm JSON (khi có multi-agent) | `claude-haiku-5-5` | Output ngắn, schema cố định |
| Sinh nhiều phương án kịch bản không gấp | Batch API | Rẻ hơn, kết quả bất đồng bộ |

**Việc cụ thể đề xuất (PR riêng, cần đo trước/sau):** thêm `cache_control: { type: 'ephemeral' }` vào khối system trong `callTool()` (`server/director.js`). Ghi `usage.cache_read_input_tokens` vào log job để kiểm chứng.

## 4. Tích hợp Higgsfield (plate video AI)

Higgsfield có MCP server với các tool phù hợp: `models_explore`, `get_presets`, `generate_image_batch`, `generate_video_batch`, `jobs_wait`, `balance`, `upscale_video`.

Hướng đề xuất khớp kiến trúc hiện có:

1. Thêm loại chất liệu **plate** trong `store.js`: video sinh từ ảnh/prompt, lưu vào `assets/` như chất liệu thường.
2. Shot code dùng `s.video()` làm nền; lớp code vẫn vẽ chữ, logo, packshot → giữ tính tất định của phần thương hiệu.
3. Một module server (vd. `server/plates.js`) là **điểm duy nhất** gọi Higgsfield, có chốt chặn:
   - kiểm `balance` trước mỗi lô, dừng nếu dưới ngưỡng;
   - sinh keyframe (ảnh) trước, duyệt rồi mới sinh video;
   - tối đa 2 lần sinh lại mỗi plate;
   - log mỗi job: shot, model, prompt, chi phí.
4. Biến môi trường mới (khi làm) phải vào `.env.example` + bảng trong README.

**Câu hỏi mở:** MCP Higgsfield xác thực OAuth theo tài khoản người dùng. Cần xác nhận có token server-to-server không; nếu không, gọi API riêng của Higgsfield từ server.

### Credit Higgsfield để thử nghiệm

- Lượt sinh miễn phí/unlimited **chỉ áp dụng trên web higgsfield.ai**; qua MCP/CLI vẫn trừ credit.
- Gói Free thực tế gần như 0 credit; trial cho tài khoản mới (~100 credit) là lượng MCP miễn phí duy nhất được ghi nhận.
- Đăng ký bằng email doanh nghiệp có thể nhận ~50 credit (nếu ưu đãi hiện khi đăng ký); FounderPass có 50 credit + giảm 50% lần thanh toán đầu.
- Code từ YouTuber/affiliate: chưa kiểm chứng, chỉ thử khi thanh toán.
- **Phương án dự phòng cho khối lượng lớn:** fal.ai có chương trình startup credit (theo đơn), gọi trực tiếp Seedance/Kling. Thiết kế `plates.js` theo adapter để đổi nhà cung cấp dễ.

## 5. Managed Agents (Agents / Environments / Deployments)

| Khái niệm | Ý nghĩa |
| --- | --- |
| Agent | model + system prompt + tools + MCP servers + skills, định nghĩa một lần, gọi theo ID |
| Environment | nơi chạy: sandbox cloud của Anthropic hoặc self-hosted |
| Session | một lần agent làm việc; lưu lịch sử + trạng thái sandbox phía server, chạy được hàng giờ, chen lệnh giữa chừng |
| Deployment | chạy agent theo cron, có lịch sử từng lần chạy, **budget theo mỗi lần chạy**, webhook |

Ứng dụng cho dự án:

- Workflow multi-agent dài hạn (brief → kịch bản → plate → QA) có thể chạy trên Managed Agents, gắn Higgsfield qua MCP, giữ token trong vault.
- Budget theo session khớp nhu cầu chốt chặn chi phí; webhook đẩy thông báo cho app mobile.
- Deployment định kỳ cho team marketing (vd. đề xuất ý tưởng nội dung mỗi sáng thứ Hai → Slack).

Cân nhắc: beta (header `managed-agents-2026-04-01`), không đủ điều kiện ZDR, có thêm chi phí runtime sandbox. **Render vẫn nên ở server Chromium + ffmpeg hiện tại** — Managed Agents chỉ thay lớp điều phối.

## 6. App mobile & App integrations (App Attest)

Cách hoạt động:

- Mỗi bản cài chứng minh là build thật qua Apple App Attest; Anthropic cấp token ngắn hạn, chi phí tính vào workspace. App **không nhúng API key**.
- Token hết hạn sau 1 giờ, chỉ dùng cho Messages API, không mang danh tính người dùng.
- Chỉ qua Swift package *Claude for Foundation Models* (beta, cần OS 27 beta), phải test trên máy thật. Không có Android, không qua Bedrock/Vertex/Foundry.

Thiết lập thử: Xcode thêm capability App Attest → Console › workspace settings › **App integrations** › Create (tên, Apple Team ID, bundle ID) → lấy `clid_...`. Cần quyền admin/owner tổ chức Console. **Revoke không hoàn tác được.**

Kiến trúc lai đề xuất:

- **Trên app (App Attest):** chat làm rõ brief, gợi ý chỉnh kịch bản.
- **Qua server Motion Studio (REST hiện có):** tạo dự án, gọi đạo diễn, render, plate Higgsfield, duyệt contact sheet, tải MP4. Mọi secret ở server.
- Lớp gọi Claude trong app thiết kế đổi được nguồn xác thực, để sau này chuyển sang gọi qua server cho Android.
- Cần auth theo người dùng cho API server trước khi mở cho mobile (hiện chỉ có `APP_PASSWORD` dùng chung).

## 7. Setup cho team marketing

Marketing không làm việc trong Console. Hai lớp:

- **Dev:** workspace "Marketing" + spending limit; đóng gói quy trình lặp lại thành agent/template (`server/templates.js` đã là điểm bắt đầu tốt).
- **Marketing dùng hằng ngày:** editor Motion Studio hiện tại, sau là app mobile / bot Slack. Chat tự do (viết bài, brainstorm) dùng claude.ai Team (Projects, Skills) — tính phí riêng.

## 8. Việc cần kiểm chứng

- [ ] Mức credit dùng thử hiện có trong Billing của Console
- [ ] Đo token/lượt đạo diễn trước & sau prompt caching
- [ ] Higgsfield có token server-to-server hay chỉ OAuth
- [ ] Model video nào trên Higgsfield hợp nội dung sự kiện/TVC, đơn giá credit/giây
- [ ] Tài khoản Apple Developer + quyền admin Console để tạo App integration
- [ ] Bảng giá runtime Managed Agents trước khi cam kết
- [ ] Tình trạng hồ sơ Claude Startup Program

## Nguồn

- [App Attest for iOS and macOS apps](https://platform.claude.com/docs/en/manage-claude/app-attest)
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments)
- [Creatify: Is Higgsfield free?](https://creatify.ai/blog/is-higgsfield-free-free-plan-trials-and-promo-codes-explained-(2026))
- [Aireiter: Higgsfield free unlimited explained](https://aireiter.com/blog/higgsfield-free-unlimited-explained)
- [Resourify: Higgsfield deals](https://resourify.com/resources/higgsfield-ai)
- [FounderPass: Higgsfield](https://www.founderpass.com/partners/higgsfield-ai)
