#!/usr/bin/env bash
# Builds the Én Nam TVC soundtrack: procedural score + Vietnamese voice-over + mix.
# Requires: python3 + numpy, ffmpeg, `pip install piper-tts`, and the Piper voice
# vi_VN-vais1000-medium (dataset CC BY 4.0) from
#   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-vi_VN-vais1000-medium.tar.bz2
# usage: scripts/audio/build_tvc_audio.sh <voice.onnx> <out.wav>
set -euo pipefail
VOICE=${1:?voice .onnx}; OUT=${2:-tvc-mix.wav}
DIR=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
python3 "$HERE/tvc_music.py" "$DIR/music.wav" --dur 30.6 --impact 15.1 --reveal 18.5 --gust 6.3
i=0
while IFS= read -r line; do
  i=$((i+1)); echo "$line" | python3 -m piper -m "$VOICE" -f "$DIR/vo$i.wav" --length-scale 1.42 --noise-scale 0.45 --noise-w-scale 0.5
done <<'TXT'
Giữa đại ngàn xanh thẳm,
dòng nước trong lành được rừng núi chắt lọc qua bao tầng đá.
Từng giọt tinh khiết,
giữ trọn sức sống của thiên nhiên.
Én Nam, nước khoáng thiên nhiên, tinh khiết từ đại ngàn.
Én Nam. Trong lành mỗi ngày.
TXT
ffmpeg -v error -y -i "$DIR/music.wav" -i "$DIR/vo1.wav" -i "$DIR/vo2.wav" -i "$DIR/vo3.wav" -i "$DIR/vo4.wav" -i "$DIR/vo5.wav" -i "$DIR/vo6.wav" -filter_complex "
[1]atempo=0.94,adelay=800|800[a1];[2]atempo=0.94,adelay=5600|5600[a2];[3]atempo=0.94,adelay=10600|10600[a3];[4]atempo=0.94,adelay=15600|15600[a4];[5]atempo=0.94,adelay=19500|19500[a5];[6]atempo=0.94,adelay=26100|26100[a6];
[a1][a2][a3][a4][a5][a6]amix=inputs=6:normalize=0,aresample=44100,pan=stereo|c0=c0|c1=c0,highpass=f=90,equalizer=f=3200:t=q:w=1.2:g=2.5,acompressor=threshold=0.12:ratio=3:attack=5:release=120,aecho=0.8:0.6:45:0.12,volume=2.2,apad=whole_dur=30.6,asplit=2[vo][vosc];
[0]volume=0.9[mus];[mus][vosc]sidechaincompress=threshold=0.04:ratio=5:attack=40:release=500[duck];
[duck][vo]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:30.5[out]" -map "[out]" -ar 48000 "$OUT"
echo "wrote $OUT"
