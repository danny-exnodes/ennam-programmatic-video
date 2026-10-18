#!/bin/sh
# Khởi động trong container: giải nén Chromium ghim từ @sparticuz/chromium rồi chạy server.
set -e
if [ -z "$CHROME_PATH" ]; then
  CHROME_PATH=$(node -e "import('@sparticuz/chromium').then(async (m) => console.log(await m.default.executablePath()))")
  export CHROME_PATH
fi
echo "Chromium: $CHROME_PATH"
exec node server/index.js
