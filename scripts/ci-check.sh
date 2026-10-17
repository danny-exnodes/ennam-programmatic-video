#!/usr/bin/env bash
# Quality gate chạy trên CI và local: `npm run check` (cần đã `npm ci`).
# BASE mặc định là origin/main; trên CI đặt BASE=origin/<nhánh đích>.
set -u
BASE=${BASE:-origin/main}
fail=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; fail=1; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error::$*"; }
warn() { echo "WARN  $*"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning::$*"; }

if git rev-parse --verify -q "$BASE" >/dev/null; then
  CHANGED=$(git diff --name-only "$BASE"...HEAD)
else
  warn "không tìm thấy $BASE — bỏ qua các kiểm tra theo diff"; CHANGED=""
fi

# 1. Cú pháp mọi file JS
s=0; for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f" 2>/dev/null || { bad "syntax: $f"; s=1; }; done
[ $s = 0 ] && ok "node --check all JS"

# 2. Engine chạy trong trình duyệt và phải tất định theo t
if grep -rnE "from ['\"](node:|fs|path|child_process|os|url)['\"]|require\(" engine; then bad "engine import Node API"; else ok "engine không import Node API"; fi
if grep -rnE "Math\.random|Date\.now|new Date|performance\.now" engine public/render-page.js; then bad "engine/render dùng Math.random/Date (không tất định)"; else ok "engine tất định"; fi

# 3. Đổi API engine thì phải cập nhật docs/SHOT_API.md
if echo "$CHANGED" | grep -q '^engine/' && ! echo "$CHANGED" | grep -q '^docs/SHOT_API.md'; then
  if git diff "$BASE"...HEAD -- engine | grep -qE '^\+.*\bexport\b'; then bad "engine thêm/sửa export nhưng chưa cập nhật docs/SHOT_API.md"
  else warn "engine thay đổi, docs/SHOT_API.md không đổi — reviewer kiểm tra lại"; fi
else ok "hợp đồng tài liệu SHOT_API"; fi

# 4. Secret và đường dẫn bị ignore
if [ -n "$CHANGED" ] && git diff "$BASE"...HEAD | grep -qE '^\+.*(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|(API_KEY|PASSWORD)=[^ #]{8,})'; then bad "có thể đã commit secret"; else ok "không lộ secret"; fi
if echo "$CHANGED" | grep -qE '^(node_modules/|data/|\.env$)'; then bad "commit node_modules/, data/ hoặc .env"; else ok "không commit đường dẫn bị ignore"; fi

# 5. Script trong package.json trỏ tới file có thật
for sc in $(node -e "const p=require('./package.json');for(const v of Object.values(p.scripts)){for(const m of v.matchAll(/(?:node(?: --watch)?|bash) (\S+\.(?:js|sh))/g))console.log(m[1])}"); do
  [ -f "$sc" ] || warn "npm script trỏ tới file không tồn tại: $sc"; done

# 6. Server khởi động và phục vụ UI + engine
PORT=${CHECK_PORT:-5399}; DD=$(mktemp -d)
PORT=$PORT DATA_DIR=$DD node server/index.js >"$DD/server.log" 2>&1 & SP=$!
for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/" >/dev/null && break; sleep 0.5; done
c1=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/")
c2=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/engine/engine.js")
kill $SP 2>/dev/null; wait $SP 2>/dev/null
if [ "$c1" = 200 ] && [ "$c2" = 200 ]; then ok "server khởi động, phục vụ / và engine"; else bad "server smoke test (/=$c1 engine=$c2)"; cat "$DD/server.log"; fi

# 7. Golden-frame render: so khớp ảnh, tất định, hiệu năng (scripts/golden.js tự in PASS/FAIL/WARN)
if [ -n "${SKIP_GOLDEN:-}" ]; then
  if [ -n "${CI:-}" ]; then bad "SKIP_GOLDEN không được phép trên CI"; else warn "bỏ qua golden-frame (SKIP_GOLDEN=1)"; fi
else
  node scripts/golden.js; gc=$?
  [ $gc = 0 ] || { fail=1; echo "FAIL  golden-frame (exit $gc) — ảnh diff ở test/golden/out/; thay đổi hình có chủ đích: node scripts/golden.js --update"; }
fi

# 8. QA đo được cho đạo diễn: 5 shot cố ý lỗi phải bị phát hiện 100%, shot lành không bị báo,
#    guard vòng cuối không ghi đè code chạy được (scripts/test-qa.js; non-Linux: bỏ qua như golden)
if [ -n "${SKIP_GOLDEN:-}" ]; then
  [ -z "${CI:-}" ] && warn "bỏ qua test-qa (SKIP_GOLDEN=1)"
else
  node scripts/test-qa.js; qc=$?
  [ $qc = 0 ] || { fail=1; echo "FAIL  test-qa (exit $qc)"; }
fi

[ $fail = 0 ] && echo "RESULT PASS" || echo "RESULT FAIL"
exit $fail
