// expect: black
// Lỗi cố ý: cả shot đen (ví dụ ảnh nền không tải được, chỉ còn lớp phủ tối).
const { W, H } = s;
s.background('#000');
s.ctx.fillStyle = 'rgba(255,255,255,0.01)';
s.ctx.fillRect(0, 0, W, H);
