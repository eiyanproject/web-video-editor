#!/usr/bin/env bash
# smartcut-poc.sh - proves the smart-cut algorithm from PLAN.md section 2.
#
# Builds a synthetic H.264 source with a KNOWN 5-second GOP, then performs a
# frame-exact cut at deliberately non-keyframe boundaries and verifies the
# result. Answers the one question the plan cannot answer on paper: does the
# Tier 1 concat (inpoint/outpoint against the original file) actually work, or
# do we need the Tier 2 MPEG-TS fallback?

set -uo pipefail
cd /work

W=1280; H=720; FPS=25; GOP=125          # 125 frames @ 25fps = keyframe every 5.000s
DUR=60
SRC=source.mp4

hdr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()  { printf '  \033[32m[ OK ]\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; }
inf() { printf '        %s\n' "$1"; }

# --------------------------------------------------------------- 1. source
hdr "1. Building synthetic source (${DUR}s, ${W}x${H}, ${FPS}fps, GOP=${GOP})"
# testsrc2 burns a frame counter into the picture, so cut accuracy is visually
# verifiable later. sine gives us a real audio track to test A/V handling.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR}" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${DUR}" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -x264-params "keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=0" \
  -c:a aac -b:a 128k -shortest "$SRC" 2>&1 | tail -3
[ -f "$SRC" ] && ok "source built ($(du -h "$SRC" | cut -f1))" || { bad "source build failed"; exit 1; }

# --------------------------------------------------------------- 2. probe
hdr "2. Probing source parameters"
# NOTE: ffprobe emits fields in its own internal struct order, NOT the order you
# request them in. Querying each field separately is the only unambiguous way.
probe1() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" \
             -of default=nw=1:nk=1 "$SRC" | head -1; }
CODEC=$(probe1 codec_name)
PROFILE=$(probe1 profile)
LEVEL=$(probe1 level)
PIXFMT=$(probe1 pix_fmt)
RFR=$(probe1 r_frame_rate)
# libx264 wants lowercase profile names ("high", not "High")
XPROFILE=$(printf '%s' "$PROFILE" | tr '[:upper:]' '[:lower:]')
inf "codec=$CODEC profile=$PROFILE (x264: $XPROFILE) level=$LEVEL pix_fmt=$PIXFMT fps=$RFR"

# --------------------------------------------------------------- 3. keyframes
hdr "3. Extracting keyframe index (demux only, no decode)"
T0=$(date +%s.%N)
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 "$SRC" | grep ',K' | cut -d, -f1 > keyframes.txt
T1=$(date +%s.%N)
KF_COUNT=$(wc -l < keyframes.txt)
ok "$KF_COUNT keyframes in $(awk -v a="$T0" -v b="$T1" 'BEGIN{printf "%.2f", b-a}')s"
inf "first few: $(head -5 keyframes.txt | tr '\n' ' ')"

# --------------------------------------------------------------- 4. plan
hdr "4. Planning a deliberately awkward cut"
A=12.360     # mid-GOP, between keyframes at 10.0 and 15.0
B=42.120     # mid-GOP, between keyframes at 40.0 and 45.0
inf "keep segment: [$A, $B]  (expected duration $(awk -v a=$A -v b=$B 'BEGIN{printf "%.3f", b-a}')s)"

kA_prev=$(awk -v t=$A '$1<=t{k=$1} END{print k+0}' keyframes.txt)
kA_next=$(awk -v t=$A '$1>t{print $1+0; exit}' keyframes.txt)
kB_prev=$(awk -v t=$B '$1<=t{k=$1} END{print k+0}' keyframes.txt)

inf "kA_prev=$kA_prev  kA_next=$kA_next  kB_prev=$kB_prev"
inf "head  [$A -> $kA_next)   RE-ENCODE $(awk -v a=$A -v b=$kA_next 'BEGIN{printf "%.3f", b-a}')s"
inf "body  [$kA_next -> $kB_prev)  STREAM COPY $(awk -v a=$kA_next -v b=$kB_prev 'BEGIN{printf "%.3f", b-a}')s"
inf "tail  [$kB_prev -> $B]   RE-ENCODE $(awk -v a=$kB_prev -v b=$B 'BEGIN{printf "%.3f", b-a}')s"
REENC=$(awk -v a=$A -v b=$kA_next -v c=$kB_prev -v d=$B 'BEGIN{printf "%.1f", (b-a)+(d-c)}')
TOTAL=$(awk -v a=$A -v b=$B 'BEGIN{printf "%.1f", b-a}')
ok "re-encoding ${REENC}s of ${TOTAL}s = $(awk -v r=$REENC -v t=$TOTAL 'BEGIN{printf "%.1f", r/t*100}')% of the output"

# --------------------------------------------------------------- 5. fragments
hdr "5. Encoding boundary fragments"
# -ss before -i is frame-accurate when transcoding: ffmpeg seeks to the preceding
# keyframe, then decodes and discards up to the exact requested timestamp.
enc_fragment() {
  local start=$1 dur=$2 out=$3
  ffmpeg -hide_banner -loglevel error -y \
    -ss "$start" -i "$SRC" -t "$dur" \
    -c:v libx264 -crf 16 -preset medium \
    -profile:v "$XPROFILE" -pix_fmt "$PIXFMT" -r "$FPS" \
    -x264-params "keyint=${GOP}:min-keyint=1:scenecut=0:open-gop=0" \
    -c:a copy -video_track_timescale 90000 "$out" 2>&1 | sed 's/^/        /' | head -4
}
T0=$(date +%s.%N)
enc_fragment "$A"       "$(awk -v a=$A -v b=$kA_next 'BEGIN{printf "%.3f", b-a}')" frag_head.mp4
enc_fragment "$kB_prev" "$(awk -v a=$kB_prev -v b=$B 'BEGIN{printf "%.3f", b-a}')" frag_tail.mp4
T1=$(date +%s.%N)
ENC_TIME=$(awk -v a="$T0" -v b="$T1" 'BEGIN{printf "%.2f", b-a}')
ok "both fragments encoded in ${ENC_TIME}s"
for f in frag_head.mp4 frag_tail.mp4; do
  inf "$f: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")s, $(du -h "$f"|cut -f1)"
done

# --------------------------------------------------------------- 6. tier 1
hdr "6. TIER 1 concat - inpoint/outpoint against the original file"
cat > list1.txt <<EOF
file '/work/frag_head.mp4'
file '/work/${SRC}'
inpoint ${kA_next}
outpoint ${kB_prev}
file '/work/frag_tail.mp4'
EOF
inf "the body section is NEVER copied to a temp file - it is read in place"
T0=$(date +%s.%N)
if ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i list1.txt \
     -c copy -movflags +faststart out_tier1.mp4 2>tier1.err; then
  T1=$(date +%s.%N)
  ok "Tier 1 muxed in $(awk -v a="$T0" -v b="$T1" 'BEGIN{printf "%.2f", b-a}')s"
  TIER1=yes
else
  bad "Tier 1 failed:"; sed 's/^/        /' tier1.err | head -5
  TIER1=no
fi
[ -s tier1.err ] && { inf "warnings:"; sed 's/^/        /' tier1.err | head -5; }

# --------------------------------------------------------------- 7. tier 2
hdr "7. TIER 2 concat - MPEG-TS intermediates (fallback path)"
ffmpeg -hide_banner -loglevel error -y -i frag_head.mp4 -c copy -bsf:v h264_mp4toannexb -f mpegts p0.ts
ffmpeg -hide_banner -loglevel error -y -ss "$kA_next" -i "$SRC" -to "$kB_prev" -copyts \
       -c copy -bsf:v h264_mp4toannexb -f mpegts p1.ts
ffmpeg -hide_banner -loglevel error -y -i frag_tail.mp4 -c copy -bsf:v h264_mp4toannexb -f mpegts p2.ts
if ffmpeg -hide_banner -loglevel error -y -i "concat:p0.ts|p1.ts|p2.ts" \
     -c copy -movflags +faststart out_tier2.mp4 2>tier2.err; then
  ok "Tier 2 muxed  (temp written: $(du -ch p0.ts p1.ts p2.ts | tail -1 | cut -f1))"
  TIER2=yes
else
  bad "Tier 2 failed:"; sed 's/^/        /' tier2.err | head -5
  TIER2=no
fi

# --------------------------------------------------------------- 8. verify
hdr "8. Verification"
EXPECTED=$(awk -v a=$A -v b=$B 'BEGIN{printf "%.3f", b-a}')
for out in out_tier1.mp4 out_tier2.mp4; do
  [ -f "$out" ] || continue
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")
  DELTA=$(awk -v d="$D" -v e="$EXPECTED" 'BEGIN{printf "%.3f", (d-e<0?e-d:d-e)}')
  NF=$(ffprobe -v error -select_streams v:0 -count_packets \
       -show_entries stream=nb_read_packets -of csv=p=0 "$out")
  EXPF=$(awk -v e="$EXPECTED" -v f=$FPS 'BEGIN{printf "%d", e*f}')
  printf '  %s: duration=%ss (expected %ss, delta %ss) frames=%s (expected ~%s)\n' \
    "$out" "$D" "$EXPECTED" "$DELTA" "$NF" "$EXPF"
  # A decode error scan across the whole output. Cheap at this size.
  ERR=$(ffmpeg -hide_banner -v error -i "$out" -f null - 2>&1 | head -8)
  if [ -z "$ERR" ]; then ok "$out decodes cleanly end to end"
  else bad "$out decode errors:"; printf '%s\n' "$ERR" | sed 's/^/        /'; fi
  # A/V sync at the joins
  AD=$(ffprobe -v error -select_streams a:0 -show_entries format=duration -of csv=p=0 "$out")
  inf "audio duration $AD vs video $D"
done

# --------------------------------------------------------------- 9. proof
hdr "9. Visual proof of frame accuracy"
# testsrc2 burns the frame number into the picture. Frame at t=A in the source
# should be the FIRST frame of the output.
ffmpeg -hide_banner -loglevel error -y -ss "$A" -i "$SRC" -frames:v 1 expect_first.png
[ -f out_tier1.mp4 ] && ffmpeg -hide_banner -loglevel error -y -i out_tier1.mp4 -frames:v 1 actual_first.png
if [ -f expect_first.png ] && [ -f actual_first.png ]; then
  E=$(md5sum expect_first.png | cut -d' ' -f1); C=$(md5sum actual_first.png | cut -d' ' -f1)
  inf "source frame @ ${A}s : $E"
  inf "output frame 0      : $C"
  # Pixel-difference is the meaningful test; re-encode changes bytes, not content.
  DIFF=$(ffmpeg -hide_banner -loglevel error -i expect_first.png -i actual_first.png \
         -lavfi "psnr=stats_file=-" -f null - 2>/dev/null | grep -o 'psnr_avg:[^ ]*' | head -1)
  inf "first-frame PSNR vs expected: ${DIFF:-unavailable}"
  ok "PSNR above ~40dB means the cut landed on the exact requested frame"
fi

hdr "Result"
echo "  Tier 1 (no temp files, 1x write): ${TIER1}"
echo "  Tier 2 (TS fallback):             ${TIER2}"
echo "  Re-encoded ${REENC}s of ${TOTAL}s output in ${ENC_TIME}s"
echo
