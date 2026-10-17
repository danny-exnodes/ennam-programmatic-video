// expect: throw
// Lỗi cố ý: lỗi runtime (truy cập thuộc tính của undefined) sau khi đã vẽ nền.
const { W, H } = s;
s.background(['#402040', '#100810']);
s.ctx.fillStyle = '#f5b54a';
s.ctx.fillRect(W * 0.4, H * 0.4, W * 0.2, H * 0.2);
const product = s.has('logo') ? { label: 'Logo' } : undefined; // chất liệu không tồn tại
s.text(product.label, { x: W / 2, y: H / 2 });
