#!/bin/sh
# supercut.sh <take.mp4> <out.mp4> <from-to> <from-to> ...: cuts the pieces named (seconds of the take) together
# into one film. The sound dips for a moment at each cut so that none of them clicks. A film that opens and closes
# on the grey page loops if its last piece ends a whole number of half minutes after its first begins.
IN=$1; OUT=$2; shift 2
N=0; GRAPH=""; ENDS=""
for PIECE in "$@"; do
  FROM=${PIECE%-*}; TO=${PIECE#*-}
  FADE=$(awk "BEGIN { printf \"%.3f\", $TO - $FROM - 0.04 }")
  GRAPH="$GRAPH[0:v]trim=$FROM:$TO,setpts=PTS-STARTPTS[v$N];[0:a]atrim=$FROM:$TO,asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=$FADE:d=0.04[a$N];"
  ENDS="$ENDS[v$N][a$N]"
  N=$((N + 1))
done
ffmpeg -loglevel error -y -i "$IN" -filter_complex "$GRAPH${ENDS}concat=n=$N:v=1:a=1[v][a]" -map "[v]" -map "[a]" \
  -c:v libx264 -profile:v high -preset slow -crf 20 -maxrate 18M -bufsize 36M -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 192k -movflags +faststart "$OUT"
