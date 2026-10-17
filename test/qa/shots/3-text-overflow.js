// expect: text_safe_area
// Lỗi cố ý: tiêu đề quá dài, không có maxWidth → tràn ra ngoài vùng an toàn 6%.
const { W, H } = s;
s.background(['#3a2410', '#120a04']);
s.text('Ưu đãi đặc biệt giảm giá *30%* toàn quốc chỉ trong hôm nay', { x: W / 2, y: H * 0.5, size: 130, align: 'center', anim: 'none' });
