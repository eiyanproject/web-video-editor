#!/usr/bin/env bash
# smartcut-poc2.sh - resolves the two defects found by smartcut-poc.sh:
#   (a) output duration ~1.04s longer than requested
#   (b) non-monotonic DTS at the joins (377+ occurrences on the Tier 1 path)
#
# Tests three concat strategies head to head and measures each objectively.

set -uo pipefail
cd /work

W=1280; H=720; FPS=25; GOP=125; DUR=60
SRC=source.mp4
A=12.360; B=42.120

hdr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()  { printf '  \033[32m[ OK ]\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; }
inf() { printf '        %s\n' "$1"; }

[ -f "$SRC" ] || { hdr "rebuilding source"; ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${DUR}" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -x264-params "keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=0" \
  -c:a aac -b:a 128k -shortest "$SRC"; }

ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 "$SRC" | grep ',K' | cut -d, -f1 > keyframes.txt
kA_next=$(awk -v t=$A '$1>t{print $1+0; exit}' keyframes.txt)
kB_prev=$(awk -v t=$B '$1<=t{k=$1} END{print k+0}' keyframes.txt)
PIXFMT=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=nw=1:nk=1 "$SRC")
XPROFILE=$(ffprobe -v error -select_streams v:0 -show_entries stream=profile -of default=nw=1:nk=1 "$SRC" | tr 'A-Z' 'a-z')

# Frame-exact counts. The plan stores cut points as FRAME INDICES, so drive the
# fragment encoders by -frames:v rather than -t. Duration-based -t was the source
# of the 2 extra frames in poc1.
fidx() { awk -v t="$1" -v f=$FPS 'BEGIN{printf "%d", int(t*f+0.5)}'; }
FA=$(fidx $A); FKA=$(fidx $kA_next); FKB=$(fidx $kB_prev); FB=$(fidx $B)
HEAD_FRAMES=$((FKA-FA)); TAIL_FRAMES=$((FB-FKB)); BODY_FRAMES=$((FKB-FKA))
EXP_FRAMES=$((FB-FA))
EXP_DUR=$(awk -v n=$EXP_FRAMES -v f=$FPS 'BEGIN{printf "%.3f", n/f}')

hdr "Plan (frame-exact)"
inf "keep [$A,$B] = frames $FA..$FB"
inf "head $HEAD_FRAMES frames | body $BODY_FRAMES frames (copy) | tail $TAIL_FRAMES frames"
inf "expected total: $EXP_FRAMES frames = ${EXP_DUR}s"

# ------------------------------------------------------------- measurement
measure() {
  local f=$1 label=$2
  [ -f "$f" ] || { bad "$label: missing"; return; }
  local cdur vdur adur nf dtsbad
  cdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  vdur=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$f")
  adur=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "$f")
  nf=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f")
  # count non-monotonic DTS in the video stream
  dtsbad=$(ffprobe -v error -select_streams v:0 -show_entries packet=dts_time -of csv=p=0 "$f" \
           | awk 'p!=""&&$1<=p{n++} {p=$1} END{print n+0}')
  printf '  %-14s container=%-10s video=%-10s audio=%-10s frames=%-5s dts_anomalies=%s\n' \
    "$label" "$cdur" "$vdur" "$adur" "$nf" "$dtsbad"
  if [ "$nf" = "$EXP_FRAMES" ]; then ok "$label frame count EXACT ($nf)"; else
    bad "$label frame count off by $((nf-EXP_FRAMES))"; fi
  if [ "$dtsbad" -eq 0 ]; then ok "$label timestamps monotonic"; else
    bad "$label has $dtsbad non-monotonic DTS"; fi
}

# ---------------------------------------------------- variant A: MP4 fragments
hdr "Building MP4 fragments (frame-count driven)"
enc_mp4() {
  ffmpeg -hide_banner -loglevel error -y -ss "$1" -i "$SRC" -frames:v "$2" \
    -c:v libx264 -crf 16 -preset medium -profile:v "$XPROFILE" -pix_fmt "$PIXFMT" -r $FPS \
    -x264-params "keyint=${GOP}:min-keyint=1:scenecut=0:open-gop=0" \
    -c:a copy -video_track_timescale 90000 "$3"
}
enc_mp4 "$A" "$HEAD_FRAMES" f_head.mp4
enc_mp4 "$kB_prev" "$TAIL_FRAMES" f_tail.mp4
inf "head=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 f_head.mp4) frames (want $HEAD_FRAMES)"
inf "tail=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 f_tail.mp4) frames (want $TAIL_FRAMES)"

hdr "VARIANT A - concat demuxer, inpoint/outpoint, no timestamp flags (poc1 baseline)"
cat > listA.txt <<EOF
file '/work/f_head.mp4'
file '/work/${SRC}'
inpoint ${kA_next}
outpoint ${kB_prev}
file '/work/f_tail.mp4'
EOF
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i listA.txt \
  -c copy -movflags +faststart outA.mp4 2>/dev/null
measure outA.mp4 "A:plain"

hdr "VARIANT B - same, plus timestamp repair flags"
ffmpeg -hide_banner -loglevel error -y -fflags +genpts -f concat -safe 0 -i listA.txt \
  -c copy -avoid_negative_ts make_zero -max_interleave_delta 0 \
  -muxpreload 0 -muxdelay 0 -movflags +faststart outB.mp4 2>/dev/null
measure outB.mp4 "B:ts-repair"

# ---------------------------------------------------- variant C: all-TS pipeline
hdr "VARIANT C - all-MPEG-TS pipeline (fragments encoded DIRECTLY to TS)"
# Encoding fragments straight to TS avoids MP4 edit lists and non-zero start_time,
# which is the suspected root cause of the DTS mess in A.
enc_ts() {
  ffmpeg -hide_banner -loglevel error -y -ss "$1" -i "$SRC" -frames:v "$2" \
    -c:v libx264 -crf 16 -preset medium -profile:v "$XPROFILE" -pix_fmt "$PIXFMT" -r $FPS \
    -x264-params "keyint=${GOP}:min-keyint=1:scenecut=0:open-gop=0" \
    -c:a copy -bsf:v h264_mp4toannexb -f mpegts "$3"
}
BODY_DUR=$(awk -v a=$kA_next -v b=$kB_prev 'BEGIN{printf "%.3f", b-a}')
enc_ts "$A" "$HEAD_FRAMES" c0.ts
ffmpeg -hide_banner -loglevel error -y -ss "$kA_next" -i "$SRC" -t "$BODY_DUR" \
  -c copy -bsf:v h264_mp4toannexb -f mpegts c1.ts
enc_ts "$kB_prev" "$TAIL_FRAMES" c2.ts
ffmpeg -hide_banner -loglevel error -y -i "concat:c0.ts|c1.ts|c2.ts" \
  -c copy -avoid_negative_ts make_zero -movflags +faststart outC.mp4 2>/dev/null
measure outC.mp4 "C:all-TS"
inf "temp written: $(du -ch c0.ts c1.ts c2.ts 2>/dev/null | tail -1 | cut -f1)"

# ---------------------------------------------------- decode integrity
hdr "Decode integrity (full pass, errors only)"
for f in outA.mp4 outB.mp4 outC.mp4; do
  [ -f "$f" ] || continue
  E=$(ffmpeg -hide_banner -v error -i "$f" -f null - 2>&1 | grep -v 'non monotonically' | head -3)
  if [ -z "$E" ]; then ok "$f decodes clean"; else bad "$f:"; printf '%s\n' "$E" | sed 's/^/        /'; fi
done

# ---------------------------------------------------- frame accuracy
hdr "Frame accuracy (first frame must equal source frame at ${A}s)"
ffmpeg -hide_banner -loglevel error -y -ss "$A" -i "$SRC" -frames:v 1 exp.png
for f in outA.mp4 outB.mp4 outC.mp4; do
  [ -f "$f" ] || continue
  ffmpeg -hide_banner -loglevel error -y -i "$f" -frames:v 1 "act_$f.png"
  P=$(ffmpeg -hide_banner -loglevel error -i exp.png -i "act_$f.png" \
      -lavfi psnr -f null - 2>&1 | grep -o 'average:[0-9.]*' | head -1 | cut -d: -f2)
  printf '  %-12s first-frame PSNR = %s dB\n' "$f" "${P:-n/a}"
done

hdr "Summary"
echo "  expected: $EXP_FRAMES frames / ${EXP_DUR}s"
echo
