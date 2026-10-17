// expect: none
// Shot lành: nền gradient, vật thể có chuyển động, chữ nằm trong vùng an toàn 6%.
const { W, H, t } = s;
s.camera({ zoom: 1 + 0.03 * s.p, shake: 2 });
s.background(['#24405a', '#0b1622']);
s.world((c) => {
  const y = H * 0.45 + Math.sin(t * 2) * 20;
  const g = c.createRadialGradient(W / 2 - 40, y - 40, 10, W / 2, y, 180);
  g.addColorStop(0, '#ffe2b0'); g.addColorStop(1, '#c46a12');
  c.fillStyle = g;
  c.beginPath(); c.arc(W / 2, y, 170, 0, s.TAU); c.fill();
});
s.text('Sáng mịn *tươi tắn*', { x: W / 2, y: H * 0.82, size: 84, align: 'center', anim: 'fade', start: 0, dur: 0.3, maxWidth: W * 0.8 });
