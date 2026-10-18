# Nghiên cứu: web-ocean (Noniv) — học gì cho engine Ennam

> Tài liệu tham khảo của BA Lead, **không phải spec đã duyệt**. Đọc mã nguồn ngày 2026-10-18, commit `a07c7fd` của [Noniv/web-ocean](https://github.com/Noniv/web-ocean) (MIT, © 2026 Maksymilian Dendura). Không chạy code của repo. Mọi con số ms trong tài liệu là **ước lượng, chưa đo**.

## Tóm tắt

- web-ocean đẹp nhờ **mô hình vật lý tốt chứ không nhờ asset**. Toàn bộ là shader sinh thủ tục, không có texture hay thư viện, bản minify chỉ 61 KB.
- **Không nhúng nguyên được:** repo bắt buộc WebGPU (`js/main.js:67-79`), trong khi pipeline render của ta chạy Chromium `--disable-gpu` với WebGL2 trên SwiftShader (`server/render.js:40`).
- **Nên học ý tưởng rồi tự viết lại bằng WebGL2**, theo thứ tự giá trị: bầu trời tán xạ khí quyển → mây 2 lớp có chiếu sáng → biển mở → tonemap HDR.
- Phần trời và mây hiện tại của ta (`engine/fx/landscape.js` ~dòng 78–89) chỉ là trộn 2 màu cộng một lớp fbm, nên chênh lệch chất lượng rất lớn. Đây là chỗ học được nhiều nhất với chi phí vừa phải.

## web-ocean làm gì

| Phần | Kỹ thuật | Vị trí |
| --- | --- | --- |
| Sóng | FFT Tessendorf, 6 cascade 256², phổ JONSWAP + trải hướng Donelan-Banner + swell, choppy + Jacobian, IFFT bằng compute shader | `js/wgsl/sim.js:29-250`, `common.js:2-4` |
| Bầu trời | Mô hình Hillaire: 3 LUT (transmittance, multiple scattering, sky-view), pha Rayleigh/Mie | `js/wgsl/sky.js:9-180`, `common.js:102-110` |
| Mây | **2 lớp phẳng** (2 km và 7 km), không phải volumetric: fbm warp, tự đổ bóng 3 mẫu về phía mặt trời, viền sáng, silver lining, AA bằng `fwidth` | `sky.js:231-330`, `ocean.js:12-36` |
| Mặt nước | Fresnel, Smith, LEAN mapping chống aliasing ở xa, subsurface ở đỉnh sóng, phản xạ env cubemap | `ocean.js`, `main.js:766-775` |
| Bọt | Sinh ở nơi Jacobian gập, trôi theo gió, tắt dần trên clipmap ping-pong | `sim.js:346-405` |
| Hậu kỳ | HDR, bloom 8 cấp, tonemap **AgX**, dither | `js/wgsl/post.js:13-125` |

## Tính tất định

Phổ sóng, mây và sky LUT về bản chất là hàm của thời gian. Tần số sóng được lượng tử hoá theo chu kỳ `LOOP = 600 s` (`main.js:424`), nên **video loop liền mạch** được, một điểm rất hay. Hai thứ **không** tất định là env cubemap (mỗi khung chỉ dựng lại 1 mặt) và bọt tích luỹ theo `dt`. Khi port: truyền `t` thay cho `simTime`, tính phản xạ trực tiếp từ sky LUT, và dùng bọt tức thời từ Jacobian.

## So với engine hiện tại

- **web-ocean vượt trội:** bầu trời và hoàng hôn đúng vật lý, mây có chiều sâu, tonemap HDR (ta đang dùng CSS filter và bloom LDR ở `engine/post.js`), mặt biển xa không lấp lánh nhiễu.
- **Ta đã có hoặc hơn:** `water.js` có gợn mao dẫn, Fresnel, lấp lánh theo pixel footprint, vệt gió giật, và mô phỏng gợn sóng do va chạm (web-ocean không có). Nhưng `water.js` chỉ 14 sóng, hợp cho suối và hồ, chưa đủ cho biển mở.

## Hướng áp dụng (ứng viên ticket BA)

| # | Hướng | Giá trị cho người dùng | File | Độ lớn |
| --- | --- | --- | --- | --- |
| 1 | **Bầu trời khí quyển** (`sc.sky`): chỉ nhập độ cao mặt trời và độ mù là ra bình minh, trưa, hoàng hôn, giờ xanh đúng màu. LUT tính một lần mỗi shot | Cảnh resort, khai trương lúc hoàng hôn, phông LED; không phải chỉnh màu tay | `fx/landscape.js`, `fx/glkit.js`, `fx/water.js` (phản xạ) | M |
| 2 | **Mây 2 lớp có chiếu sáng**: tự đổ bóng, silver lining, AA, cache panorama theo key | Bầu trời "điện ảnh" cho poster động, teaser | `fx/landscape.js` | S–M |
| 3 | **Biển mở** (`water({mode:'ocean'})`): 24–48 sóng Gerstner sinh từ phổ JONSWAP theo seed, ω lượng tử hoá để loop, bọt từ Jacobian, vệt nắng trên biển | Biển, bãi biển, du thuyền, lễ hội biển; video loop cho màn LED | `fx/water.js`, `fx/nature.js` | M (FFT thật: L) |
| 4 | **Tonemap AgX + bloom HDR** cho các pass GL | Mặt trời và đèn sân khấu sáng mềm, không cháy; có lợi cho mọi cảnh, kể cả Year End | `post.js`, `fx/glkit.js` | M (đổi mọi golden) |

**Hiệu năng (ước lượng):** port nguyên bản trên CPU raster tốn 1–5 s/khung, không dùng được. Bản rút gọn (sky LUT, mây phẳng, nước giao tia mặt phẳng, render 0.5–0.6 rồi upscale) tốn khoảng 80–200 ms/khung, cùng tầm với `nature` hiện nay. Phải xác nhận bằng `scripts/bench.js`.

**Không khuyến nghị:** đổi pipeline sang WebGPU lúc này. Việc đó đòi đổi cờ Chromium, hỗ trợ SwiftShader-Vulkan headless chưa chắc chắn, và toàn bộ golden sẽ đổi.

## Giấy phép

MIT. Nếu dịch hoặc chép code (kể cả chuyển WGSL sang GLSL), phải giữ notice bản quyền và toàn văn MIT trong file đó hoặc trong `THIRD_PARTY_NOTICES`. Nếu tự viết lại từ công bố gốc (Tessendorf 2001, Hillaire 2020, AgX) thì chỉ cần ghi nguồn tham khảo.
