# Đánh giá công nghệ & kế hoạch nâng cao độ chân thực

## 1. Hiện trạng (bản đầu tiên)

Engine vẽ mọi thứ bằng **Canvas 2D**, vật lý chạy trên CPU theo hướng tất định (tốt), nhưng phần *hình* và phần *động lực học* của chất lỏng đều là xấp xỉ 2D:

| Thành phần | Cách làm cũ | Vì sao trông "thô, cứng" |
|---|---|---|
| Mặt nước (`drawPool`) | dải gradient phẳng + một vệt sáng ngang | Không có pháp tuyến bề mặt → không phản chiếu, không khúc xạ, không lấp lánh; mặt nước đứng im |
| Gợn sóng (`drawRipple`) | vẽ 3 elip đồng tâm nở ra | Gợn không làm méo hình phản chiếu, không giao thoa, không trôi theo dòng, không tán sắc (nhiều vòng) |
| Vương miện, tia Worthington | đa giác 2D hình học + gradient | Đúng nhịp thời gian nhưng phẳng, viền cứng, không truyền sáng thật |
| Giọt (`drawDroplet`) | gradient tròn + điểm sáng | Không "nhìn thấy" cảnh phía sau → giống hạt nhựa, không giống nước |
| Hạt (`sim.js`) | trọng lực + lực cản tuyến tính + nhiễu | Không có định hướng/khí động học → lá, cánh hoa chỉ rơi thẳng xoay đều |
| Gió | không có trường gió chung; mỗi hiệu ứng tự lắc bằng `sin` | Các vật không cùng phản ứng với một cơn gió → mất cảm giác "có không khí" |
| Camera | 2D (zoom/dịch) + thị sai giả | Không có phối cảnh thật, không có độ sâu trường ảnh vật lý |
| Render | CPU raster, không GPU | Mọi hiệu ứng theo pixel đều quá đắt trên Canvas 2D |

Kết luận: nền tảng (tất định, render song song, đạo diễn AI tự duyệt) tốt, nhưng **thiếu 3 thứ tạo nên cảm giác thật**: (1) bề mặt nước có pháp tuyến và quang học Fresnel, (2) động lực học có nguyên nhân chung (gió, va chạm truyền năng lượng giữa các vật), (3) quang học ống kính (phối cảnh, DOF, phản chiếu).

## 2. Đã làm trong đợt này

Giữ nguyên kiến trúc (shot là code, tất định theo `t`, editor = bản xuất), thêm lớp **thế giới 3D thiên nhiên** `s.nature(...)` và **WebGL2** cho phần cần tô theo pixel (chạy được cả trong Chromium headless bằng SwiftShader).

| Hạng mục | Mô hình vật lý / kỹ thuật |
|---|---|
| Gió (`fx/wind.js`) | Một trường gió duy nhất: gió giật bất đối xứng (lên nhanh, tắt chậm) lan theo mặt trước gió với vận tốc riêng → cơn gió quét qua khung từ phía đầu gió; nhiễu loạn "đóng băng" trôi theo gió (giả thuyết Taylor). Cùng một công thức chạy ở JS và GLSL |
| Nước (`fx/water.js`) | Sóng gió: phổ 14 sóng có tán sắc thật ω² = g·k + (σ/ρ)·k³, bị dòng chảy mang đi (Doppler), biên độ theo gió giật → vệt "cat's paw" chạy trên mặt nước. Dòng chảy: xoáy nhỏ trôi theo dòng, vệt bọt. Gợn do va chạm: mô phỏng trường độ cao (phương trình sóng + số hạng ∇⁴ cho tán sắc → nhiều vòng gợn), chạy trong hệ quy chiếu trôi theo dòng nên gợn trôi xuôi mà không bị nhoè số |
| Quang học nước | Phản xạ phẳng của cảnh (vẽ lại mọi vật qua camera gương) bị méo theo pháp tuyến, Fresnel Schlick (F0 = 0.02), khúc xạ xuống đáy sỏi có caustics, hấp thụ Beer–Lambert, lấp lánh mặt trời có khử răng cưa theo kích thước pixel, sương mù khí quyển |
| Lá rơi (`fx/foliage.js`) | Tấm mỏng chuẩn tĩnh (Andersen–Pesavento–Wang 2005): lực cản dị hướng (ngang ≫ dọc), lực nâng do hoàn lưu, mômen xoay tấm vuông góc dòng khí, giảm chấn quay bậc hai → tự xuất hiện chế độ đong đưa lượn (±60–80°, chu kỳ ~1 s) và lộn vòng. Lá chạm nước → nổi, trôi theo dòng + bị gió đẩy, sinh gợn |
| Cỏ lau | Dao động tắt dần chịu lực cản gió bậc hai, mỗi ngọn tần số riêng |
| Lá có sương (`fx/dew.js`, `fx/leafgl.js`) | Lá: hai dao động quay (gập, lật) do gió + trọng lượng giọt. Giọt: bị ghim bởi trễ góc tiếp xúc (m·g·sinα > k·r → giọt to mới trượt), trượt có ma sát nhớt, gom giọt (r = ∛(r₁³+r₂³)), treo ở mũi lá, đứt theo định luật Tate; lá bật lên khi mất tải. Giọt rơi dao động hình dạng (mode 2 Rayleigh), chạm nước → hố, tia Worthington, giọt phụ rơi lại tạo vòng gợn thứ hai. Lá tô theo pixel: gân chính/ phụ/ mạng lưới, rãnh gân làm lệch pháp tuyến, sáp bóng Fresnel, xuyên sáng khi ngược sáng |
| Giọt như thấu kính | Giọt đọng phóng to & làm sáng bề mặt lá bên dưới; giọt treo/ giọt bay cho thấy cảnh phía sau lộn ngược; viền tối khúc xạ, phản chiếu trời, điểm sáng mặt trời |
| Ống kính | Camera pinhole thật (mét, fov, pitch/yaw), độ sâu trường ảnh vật lý (blur ∝ |1/d − 1/focus|), làm mờ bằng đường giảm độ phân giải (rẻ trên CPU), quay chậm bằng ánh xạ thời gian mô phỏng |

Chi phí: ~1–1.8 s/mẫu ở 1080p trên 2 nhân CPU (nước tô ở 0.5–0.7 độ phân giải rồi phóng lên). Với motion blur 3 mẫu, 16 s video ≈ 20–30 phút trên máy 2 nhân; máy có GPU đặt `RENDER_GPU=1` sẽ nhanh hơn nhiều.

## 2b. Đợt 2 (TVC Én Nam)

- **Phông núi rừng WebGL** (`fx/landscape.js`): bầu trời, 4 lớp núi tan vào sương, mặt rừng nhìn từ trên cao, bìa rừng gồm từng tán cây (tán con dạng súp lơ, viền ngược sáng, lỗ trời), hàng cây phía sau.
- **Tia nắng thể tích**: tích luỹ ánh sáng theo hướng mặt trời trong không gian màn hình, bị tán lá/đá/chim che.
- **Đá suối dạng lưới 3D** (`fx/rockgl.js`) + **vệt dòng chảy** trong shader nước: cổ bọt quanh đá, xoáy loang và sóng chữ V phía hạ lưu.
- **Lá tiền cảnh** dùng chung shader lá, **chim én** đập cánh/lượn, **chai PET** (`fx/bottle.js`) khúc xạ như thấu kính trụ, nhãn quấn trụ, hơi lạnh và giọt đọng.
- **Âm thanh**: nhạc nền tổng hợp (`scripts/audio/tvc_music.py`), lồng tiếng Việt offline (Piper), mix có ducking (`build_tvc_audio.sh`).
- **Thư viện chất liệu**: `library/sources.json` (giấy phép, được dùng quảng cáo hay không) + `scripts/library-import.js` tải từ Pexels/Pixabay/Openverse/Poly Haven kèm file thông tin giấy phép.

## 3. Lộ trình tiếp theo (đề xuất, theo thứ tự lợi ích/chi phí)

1. **Nước gần camera bằng mô phỏng GPU** — chuyển mô phỏng trường độ cao lên shader (ping-pong texture) để tăng lưới lên 1024² và có thêm tương tác vật nổi ↔ sóng (lá bị sóng đẩy). Ước tính 2–3 ngày.
2. **Bọt/ tia nước bằng hạt SPH 2.5D** cho thác nhỏ, nước va đá, rót cận cảnh; vẽ bằng metaball (screen-space fluid). 3–5 ngày.
3. **Chất liệu ảnh thật cho phông** — cho phép `sc.backdrop` nhận ảnh/ video (rừng, bầu trời) kèm depth ước lượng; phản chiếu tự lấy từ ảnh. Phông vẽ thủ tục hiện vẫn hơi "minh hoạ" khi nét. 1–2 ngày.
4. **Plate video AI (Higgsfield/Kling/Veo) + lớp vật lý bằng code** — với cảnh cần ảnh thật tuyệt đối (rừng, thác lớn), sinh plate bằng AI rồi chồng lớp code (giọt, gợn, chữ, logo) lên trên, khớp ánh sáng bằng tham số `sun`. Đây là cách đạt "photoreal" nhanh nhất cho marketing; engine vẫn đảm bảo thương hiệu & timing.
5. **Đồng bộ âm thanh theo sự kiện vật lý** — sự kiện va chạm (giọt chạm nước, lá chạm nước, gió giật) xuất ra timeline để tự đặt SFX (đã làm thủ công trong `seed-nature.js`).
6. **Lá thứ cấp & tán cây gần** dùng chung shader `leafgl` (instancing) để có tán lá tiền cảnh bokeh thật.
7. **Hiệu năng render** — cache phông tĩnh giữa các khung khi camera đứng yên; worker riêng cho mô phỏng; bật GPU khi có.

## 4. Cách thử
```bash
npm start
npm run seed:nature     # tạo dự án "Thiên nhiên: gió, lá, sương" + âm thanh môi trường
# mở dự án trong editor → Xuất MP4
```
