// expect: slow
// Lỗi cố ý: vòng lặp quá nặng mỗi khung (> 500 ms/khung).
const { W, H, t } = s;
let acc = 0;
for (let i = 0; i < 30000000; i++) acc += Math.sin(i * 0.001 + t);
s.background(['#1b3b2a', '#08140e']);
s.ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.0000001 * Math.abs(acc % 1)})`;
s.ctx.fillRect(W * 0.3, H * 0.3, W * 0.4, H * 0.4);
