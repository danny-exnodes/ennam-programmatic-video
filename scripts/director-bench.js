// Đo token của đạo diễn AI có/không prompt caching trên dự án demo "Lumi C+".
// usage: node --env-file=.env scripts/director-bench.js [--n 3] [--no-cache | --cache-only | --review] [--project <id>]
//   mặc định: mỗi brief chạy 2 lần — không cache (đối chứng) rồi có cache — và in % thay đổi.
//   --no-cache   chỉ chạy bản không cache (tắt breakpoint)
//   --cache-only chỉ chạy bản có cache
//   --review     (#5b) so output token của các VÒNG DUYỆT (lượt ≥ 2): kiểu cũ ép nộp lại cả bản
//                dựng (reviewTools=false) vs approve_cut/patch_shots; cả hai đều bật cache.
// Cần ANTHROPIC_API_KEY (tốn phí API thật) và server đang chạy (`npm start`) vì
// bước render thử tải engine qua HTTP. Không lưu gì vào dự án.
import { spawnSync } from 'node:child_process';
import { listProjects, loadProject } from '../server/store.js';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Thiếu ANTHROPIC_API_KEY — script này gọi Claude API thật. Đặt biến môi trường rồi chạy lại, ví dụ: node --env-file=.env scripts/director-bench.js');
  process.exit(1);
}

const { runDirector } = await import('../server/director.js');

const BRIEFS = [
  'Video 15s cho serum Lumi C+, cảm giác sang trọng ấm, cận cảnh giọt serum rơi, kết bằng CTA đặt hàng.',
  'Cắt nhanh hơn theo nhịp nhạc, thêm một shot nhấn 3 lợi ích: thẩm thấu nhanh, sáng da, mờ thâm.',
  'Đổi tông màu sang sáng sạch (clean), chữ to hơn cho bản xem trên điện thoại, giữ nguyên thông điệp.',
];
const n = Math.max(1, Math.min(BRIEFS.length, Number(opt('--n', BRIEFS.length)) || BRIEFS.length));
const REVIEW = flag('--review');
const modes = flag('--no-cache') ? [false] : flag('--cache-only') ? [true] : [false, true];

async function findDemo() {
  const id = opt('--project');
  if (id) return loadProject(id);
  const find = async () => (await listProjects()).find((p) => p.name === 'Lumi C+ (demo)');
  let hit = await find();
  if (!hit) {
    console.error('Chưa có dự án demo — chạy scripts/seed-demo.js (cần server đang chạy)…');
    const r = spawnSync(process.execPath, ['scripts/seed-demo.js'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('Seed thất bại. Hãy chạy `npm start` rồi `npm run seed`.'); process.exit(1); }
    hit = await find();
  }
  if (!hit) { console.error('Không tìm thấy dự án "Lumi C+ (demo)".'); process.exit(1); }
  return loadProject(hit.id);
}

// Chi phí input quy đổi theo giá input thường (TTL 5 phút: ghi cache ×1.25, đọc cache ×0.1).
const inputCost = (t) => t.input_tokens + 1.25 * t.cache_creation_input_tokens + 0.1 * t.cache_read_input_tokens;
const fmtN = (x) => Math.round(x).toLocaleString('en-US');
const pct = (a, b) => (a ? `${(((b - a) / a) * 100).toFixed(1)}%` : '—');

const project = await findDemo();

if (REVIEW) {
  // Output token vòng duyệt = tổng output các lượt sau lượt dựng đầu tiên.
  const runs = [];
  for (let i = 0; i < n; i++) {
    for (const reviewTools of [false, true]) {
      const label = `#${i + 1} ${reviewTools ? 'approve/patch' : 'nộp lại cả bản'}`;
      console.error(`▶ ${label}: ${BRIEFS[i]}`);
      const t0 = Date.now();
      const out = await runDirector(project, { brief: BRIEFS[i], cache: true, review: true, reviewTools, log: (l) => console.error('   ' + l) });
      const u = out.lastDirector.usage;
      const reviewOut = u.rounds.slice(1).reduce((a, r) => a + r.output_tokens, 0);
      runs.push({ brief: i + 1, reviewTools, tools: out.lastDirector.tools || [], first: u.rounds[0]?.output_tokens || 0, reviewOut, reviewRounds: u.rounds.length - 1, total: u.total, secs: (Date.now() - t0) / 1000 });
    }
  }
  const lines = ['| Brief | Chế độ | Tool từng lượt | Output lượt dựng | Output vòng duyệt | Số vòng duyệt | Output tổng | Thời gian |', '|---|---|---|---:|---:|---:|---:|---:|'];
  for (const r of runs) lines.push(`| ${r.brief} | ${r.reviewTools ? 'approve/patch' : 'nộp lại cả bản'} | ${r.tools.join(' → ')} | ${fmtN(r.first)} | ${fmtN(r.reviewOut)} | ${r.reviewRounds} | ${fmtN(r.total.output_tokens)} | ${r.secs.toFixed(0)}s |`);
  console.log('\n' + lines.join('\n'));
  // So theo output trung bình MỖI vòng duyệt (số vòng có thể khác nhau giữa 2 chế độ).
  const perRound = (rs) => { const k = rs.reduce((a, r) => a + r.reviewRounds, 0); return k ? rs.reduce((a, r) => a + r.reviewOut, 0) / k : 0; };
  const cmp = ['', '| Brief | Output/vòng duyệt (cũ) | Output/vòng duyệt (approve/patch) | Thay đổi |', '|---|---:|---:|---:|'];
  for (let i = 1; i <= n; i++) {
    const a = perRound(runs.filter((r) => r.brief === i && !r.reviewTools)), b = perRound(runs.filter((r) => r.brief === i && r.reviewTools));
    cmp.push(`| ${i} | ${fmtN(a)} | ${fmtN(b)} | ${pct(a, b)} |`);
  }
  const A = perRound(runs.filter((r) => !r.reviewTools)), B = perRound(runs.filter((r) => r.reviewTools));
  cmp.push(`| **Tổng** | **${fmtN(A)}** | **${fmtN(B)}** | **${pct(A, B)}** |`);
  console.log(cmp.join('\n'));
  console.log('\nTiêu chí #5: output token vòng duyệt giảm ≥ 60% khi đạo diễn duyệt không sửa (approve_cut).');
  process.exit(0);
}
console.error(`Dự án: ${project.name} (${project.id}) · ${n} brief · chế độ: ${modes.map((m) => (m ? 'cache' : 'không cache')).join(' + ')}`);

const rows = [];
for (let i = 0; i < n; i++) {
  for (const cache of modes) {
    const label = `#${i + 1} ${cache ? 'cache' : 'không cache'}`;
    console.error(`▶ ${label}: ${BRIEFS[i]}`);
    const t0 = Date.now();
    const out = await runDirector(project, { brief: BRIEFS[i], cache, log: (l) => console.error('   ' + l) });
    const u = out.lastDirector.usage;
    rows.push({ brief: i + 1, cache, rounds: u.rounds.length, total: u.total, secs: (Date.now() - t0) / 1000 });
  }
}

const head = '| Brief | Chế độ | Lượt | input | output | cache read | cache write | Input quy đổi | Thời gian |';
const lines = [head, '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
for (const r of rows) {
  const t = r.total;
  lines.push(`| ${r.brief} | ${r.cache ? 'cache' : 'không cache'} | ${r.rounds} | ${fmtN(t.input_tokens)} | ${fmtN(t.output_tokens)} | ${fmtN(t.cache_read_input_tokens)} | ${fmtN(t.cache_creation_input_tokens)} | ${fmtN(inputCost(t))} | ${r.secs.toFixed(0)}s |`);
}
console.log('\n' + lines.join('\n'));

if (modes.length === 2) {
  const cmp = ['', '| Brief | Input quy đổi không cache | Input quy đổi có cache | Thay đổi | Output thay đổi |', '|---|---:|---:|---:|---:|'];
  let a = 0, b = 0;
  for (let i = 1; i <= n; i++) {
    const off = rows.find((r) => r.brief === i && !r.cache), on = rows.find((r) => r.brief === i && r.cache);
    a += inputCost(off.total); b += inputCost(on.total);
    cmp.push(`| ${i} | ${fmtN(inputCost(off.total))} | ${fmtN(inputCost(on.total))} | ${pct(inputCost(off.total), inputCost(on.total))} | ${pct(off.total.output_tokens, on.total.output_tokens)} |`);
  }
  cmp.push(`| **Tổng** | **${fmtN(a)}** | **${fmtN(b)}** | **${pct(a, b)}** | |`);
  console.log(cmp.join('\n'));
  console.log('\nInput quy đổi = input + 1.25 × cache write + 0.1 × cache read (giá cache TTL 5 phút, tính theo đơn giá input).');
}

process.exit(0); // đóng Chromium headless còn mở từ bước render thử
