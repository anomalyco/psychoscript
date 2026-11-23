#!/bin/sh
# same.sh <a.js> <b.js> [times...]: draws both copies of liquid.js at each time (wide, 1440x900, 300 steps of
# the show) and counts the pixels that differ by more than 1.5%. Paths are as seen from tools/.
A=$1; B=$2; shift 2
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
for T in ${@:-6 14 30}; do
  LIQUID=$A deno run -A --unstable-webgpu frame.mjs wide $T $OUT/a.png 1 300 >/dev/null 2>&1
  LIQUID=$B deno run -A --unstable-webgpu frame.mjs wide $T $OUT/b.png 1 300 >/dev/null 2>&1
  printf "t=$T differing pixels: "; magick compare -metric AE -fuzz 1.5% $OUT/a.png $OUT/b.png null: 2>&1 | cut -d' ' -f1; echo
done
rm -rf $OUT
