// expect: banned_phrase
// Lỗi cố ý: tiêu đề (mặc định field) chứa câu chữ bị cấm theo Brand Kit của dự án ("cam kết 100%").
const { W, H } = s;
const headline = s.field('headline', 'Trắng da *cam kết 100%*', { label: 'Tiêu đề', maxLength: 60 });
s.camera({ zoom: 1 + 0.03 * s.p });
s.background(['#24405a', '#0b1622']);
s.fx.bokeh({ count: 12, opacity: 0.2, seed: 3 });
s.text(headline, { x: W / 2, y: H * 0.5, size: 80, align: 'center', anim: 'none', maxWidth: W * 0.8, maxLines: 2 });
