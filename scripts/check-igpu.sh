#!/usr/bin/env bash
# check-igpu.sh - read-only iGPU / QSV readiness check for a Proxmox VE host.
#
# Makes NO changes: no installs, no modprobe, no config edits. Everything it
# runs is a query. Safe to run on a production host.
#
# Usage:  bash check-igpu.sh
# Best run as root (some probes need it); it will tell you what it skipped.

set -uo pipefail

PASS=0; WARN=0; FAIL=0

c_reset=$'\033[0m'; c_bold=$'\033[1m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'

hdr()  { printf '\n%s== %s ==%s\n' "$c_bold" "$1" "$c_reset"; }
ok()   { printf '  %s[ OK ]%s %s\n'   "$c_green"  "$c_reset" "$1"; PASS=$((PASS+1)); }
warn() { printf '  %s[WARN]%s %s\n'   "$c_yellow" "$c_reset" "$1"; WARN=$((WARN+1)); }
bad()  { printf '  %s[FAIL]%s %s\n'   "$c_red"    "$c_reset" "$1"; FAIL=$((FAIL+1)); }
info() { printf '  %s      %s%s\n'    "$c_dim" "$1" "$c_reset"; }

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -ne 0 ]; then
  printf '%s! Not running as root - dmesg and some sysfs probes may be unavailable.%s\n' \
    "$c_yellow" "$c_reset"
fi

# ---------------------------------------------------------------- host / CPU
hdr "Host"
info "$(uname -srm)"
if have pveversion; then
  info "$(pveversion 2>/dev/null | head -1)"
else
  warn "pveversion not found - is this actually the Proxmox host and not a container?"
fi

hdr "CPU"
CPU_MODEL=$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
if [ -n "${CPU_MODEL:-}" ]; then
  info "$CPU_MODEL"
  case "$CPU_MODEL" in
    *Intel*)
      ok "Intel CPU detected"
      # Suffix heuristics: F = no iGPU, most Xeon = no iGPU.
      if printf '%s' "$CPU_MODEL" | grep -qiE 'i[3579]-[0-9]+[A-Z]*F([^A-Z]|$)'; then
        bad "Model suffix 'F' means this CPU has NO integrated graphics."
        info "You would need a discrete GPU, or CPU-only encoding."
      fi
      if printf '%s' "$CPU_MODEL" | grep -qi 'xeon'; then
        warn "Xeon detected - most Xeons have no iGPU (E3-xxxx v3/v5 'P' variants are exceptions)."
      fi
      ;;
    *AMD*)
      warn "AMD CPU - no Intel QSV. If this has an integrated Radeon, VAAPI encoding may work;"
      info "the plan's QSV paths would need swapping for VAAPI equivalents."
      ;;
    *) warn "Could not classify CPU vendor." ;;
  esac
else
  warn "Could not read /proc/cpuinfo model name"
fi

# ------------------------------------------------------------- PCI device
hdr "PCI graphics devices"
if have lspci; then
  GFX=$(lspci -nn 2>/dev/null | grep -iE 'vga|display|3d controller')
  if [ -n "$GFX" ]; then
    printf '%s\n' "$GFX" | while IFS= read -r line; do info "$line"; done
    if printf '%s' "$GFX" | grep -qi 'intel'; then
      ok "Intel graphics device present on the PCI bus"
    else
      bad "No Intel graphics device found on the PCI bus."
      info "If the CPU should have an iGPU, it is likely DISABLED IN BIOS."
      info "Look for: iGPU Multi-Monitor / Internal Graphics / Primary Display = Auto or IGFX."
      info "Many boards disable the iGPU automatically when a discrete GPU is installed."
    fi
  else
    bad "No VGA/Display controller found at all"
  fi

  # Driver binding per graphics device
  for slot in $(lspci -D 2>/dev/null | grep -iE 'vga|display|3d controller' | cut -d' ' -f1); do
    drv=$(lspci -k -s "$slot" 2>/dev/null | awk -F': ' '/Kernel driver in use/{print $2}')
    if [ -n "$drv" ]; then
      case "$drv" in
        i915|xe) ok "$slot bound to kernel driver '$drv'" ;;
        vfio-pci)
          bad "$slot is bound to vfio-pci - it is passed through to a VM."
          info "The host (and therefore LXC containers) cannot use it while this holds."
          ;;
        *) warn "$slot bound to unexpected driver '$drv'" ;;
      esac
    else
      warn "$slot has NO kernel driver bound"
    fi
  done
else
  warn "lspci not installed - run: apt install pciutils"
fi

# ------------------------------------------------------------- kernel module
hdr "Kernel driver"
if lsmod 2>/dev/null | grep -qE '^(i915|xe) '; then
  ok "$(lsmod | grep -E '^(i915|xe) ' | awk '{print $1}' | tr '\n' ' ')module loaded"
else
  bad "Neither i915 nor xe module is loaded"
  info "Check 'dmesg | grep -i i915' for why, and whether it is blacklisted:"
  info "  grep -r i915 /etc/modprobe.d/ 2>/dev/null"
fi

if grep -rqs 'blacklist[[:space:]]\+i915' /etc/modprobe.d/ 2>/dev/null; then
  bad "i915 is BLACKLISTED in /etc/modprobe.d/ - typically left over from a GPU passthrough setup"
  grep -rns 'blacklist[[:space:]]\+i915' /etc/modprobe.d/ 2>/dev/null | while IFS= read -r l; do info "$l"; done
fi

if [ -r /proc/cmdline ]; then
  if grep -q 'i915.enable_guc' /proc/cmdline; then
    info "kernel cmdline: $(tr ' ' '\n' < /proc/cmdline | grep i915)"
  fi
fi

# ------------------------------------------------------------- /dev/dri
hdr "Render nodes (/dev/dri)"
if [ -d /dev/dri ]; then
  ls -l /dev/dri 2>/dev/null | tail -n +2 | while IFS= read -r l; do info "$l"; done
  RENDER_NODES=$(ls /dev/dri/renderD* 2>/dev/null)
  if [ -n "$RENDER_NODES" ]; then
    ok "Render node present: $(printf '%s' "$RENDER_NODES" | tr '\n' ' ')"
    for n in $RENDER_NODES; do
      GID=$(stat -c '%g' "$n" 2>/dev/null)
      GNAME=$(stat -c '%G' "$n" 2>/dev/null)
      MAJMIN=$(stat -c '%t:%T' "$n" 2>/dev/null)
      MAJ=$((16#${MAJMIN%%:*})); MIN=$((16#${MAJMIN##*:}))
      ok "$n  gid=$GID ($GNAME)  device=$MAJ:$MIN"
      info "^ note this GID - the unprivileged LXC needs it mapped through"
    done
  else
    bad "No renderD* node - the iGPU cannot be used for compute/encode even if a card node exists"
  fi
else
  bad "/dev/dri does not exist - no DRM device available on this host"
fi

# ------------------------------------------------------------- device details
hdr "Device identity"
for d in /sys/class/drm/card*/device; do
  [ -e "$d/vendor" ] || continue
  V=$(cat "$d/vendor" 2>/dev/null); P=$(cat "$d/device" 2>/dev/null)
  info "$(basename "$(dirname "$d")"): vendor=$V device=$P"
  [ "$V" = "0x8086" ] && ok "$(basename "$(dirname "$d")") is Intel (0x8086)"
done

# ------------------------------------------------------------- dmesg
hdr "Kernel messages"
if have dmesg && dmesg -t >/dev/null 2>&1; then
  DM=$(dmesg -t 2>/dev/null | grep -iE 'i915|xe |drm' | tail -15)
  if [ -n "$DM" ]; then
    printf '%s\n' "$DM" | while IFS= read -r l; do info "$l"; done
    if printf '%s' "$DM" | grep -qiE 'GuC firmware.*(loaded|version)'; then
      ok "GuC firmware loaded (good sign for media engine health)"
    fi
    if printf '%s' "$DM" | grep -qiE 'failed to load|firmware.*not found|error'; then
      warn "Errors present in i915/drm kernel log - read the lines above"
    fi
  else
    warn "No i915/drm lines in the kernel ring buffer (may have rotated out)"
  fi
else
  warn "dmesg unreadable (need root, or kernel.dmesg_restrict=1)"
fi

# ------------------------------------------------------------- VA-API
hdr "VA-API capability"
if have vainfo; then
  VAOUT=$(vainfo 2>&1)
  DRIVER=$(printf '%s' "$VAOUT" | grep -i 'Driver version' | head -1)
  [ -n "$DRIVER" ] && info "$DRIVER"
  if printf '%s' "$VAOUT" | grep -q 'VAProfileH264.*VAEntrypointEncSlice'; then
    ok "H.264 HARDWARE ENCODE supported"
  else
    warn "No H.264 encode entrypoint reported"
  fi
  if printf '%s' "$VAOUT" | grep -q 'VAProfileH264.*VAEntrypointVLD'; then
    ok "H.264 hardware DECODE supported  <- this is what the plan mainly needs"
  else
    warn "No H.264 decode entrypoint reported"
  fi
  if printf '%s' "$VAOUT" | grep -q 'VAProfileHEVCMain.*VAEntrypointVLD'; then
    ok "HEVC hardware decode supported"
  fi
  if printf '%s' "$VAOUT" | grep -q 'VAProfileHEVCMain.*VAEntrypointEncSlice'; then
    ok "HEVC hardware encode supported"
  fi
  if printf '%s' "$VAOUT" | grep -qiE 'failed|error'; then
    warn "vainfo reported errors:"
    printf '%s' "$VAOUT" | grep -iE 'failed|error' | while IFS= read -r l; do info "$l"; done
  fi
else
  warn "vainfo not installed - this is THE definitive test, worth installing"
  info "  apt update && apt install -y vainfo intel-media-va-driver-non-free"
  info "  (non-free driver = Broadwell/gen8 and newer; older chips use i965-va-driver)"
fi

# ------------------------------------------------------------- ffmpeg probe
hdr "ffmpeg (optional, host-side sanity check)"
if have ffmpeg; then
  info "$(ffmpeg -version 2>/dev/null | head -1)"
  HW=$(ffmpeg -hide_banner -hwaccels 2>/dev/null | tail -n +2 | tr -d ' ' | tr '\n' ' ')
  info "hwaccels: $HW"
  printf '%s' "$HW" | grep -q qsv   && ok "QSV hwaccel compiled in"
  printf '%s' "$HW" | grep -q vaapi && ok "VAAPI hwaccel compiled in"

  if [ -e /dev/dri/renderD128 ]; then
    if ffmpeg -hide_banner -loglevel error -init_hw_device vaapi=hw:/dev/dri/renderD128 \
        -f lavfi -i testsrc=size=640x360:rate=30:duration=1 \
        -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null - >/dev/null 2>&1; then
      ok "LIVE TEST PASSED - encoded a test clip on the iGPU via VAAPI"
    else
      warn "Live VAAPI encode test failed (decode-only use may still be fine)"
      info "Rerun without -loglevel error to see the reason:"
      info "  ffmpeg -init_hw_device vaapi=hw:/dev/dri/renderD128 -f lavfi \\"
      info "    -i testsrc=size=640x360:rate=30:duration=1 \\"
      info "    -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null -"
    fi
  fi
else
  info "ffmpeg not installed on the host - fine, it belongs in the container."
  info "Install it here only if you want the live test: apt install -y ffmpeg"
fi

# ------------------------------------------------------------- passthrough conflicts
hdr "Passthrough conflicts"
CONFLICT=0
if ls /etc/pve/qemu-server/*.conf >/dev/null 2>&1; then
  for f in /etc/pve/qemu-server/*.conf; do
    if grep -qE '^hostpci[0-9]+:.*(00:02|8086)' "$f" 2>/dev/null; then
      warn "VM $(basename "$f" .conf) appears to pass through the iGPU: $(grep -E '^hostpci' "$f" | tr '\n' ' ')"
      CONFLICT=1
    fi
  done
fi
if ls /etc/pve/lxc/*.conf >/dev/null 2>&1; then
  for f in /etc/pve/lxc/*.conf; do
    if grep -qE 'dri|renderD' "$f" 2>/dev/null; then
      info "LXC $(basename "$f" .conf) already has a /dev/dri mapping (sharing is fine)"
    fi
  done
fi
[ "$CONFLICT" -eq 0 ] && ok "No VM is claiming the iGPU exclusively"

# ------------------------------------------------------------- verdict
hdr "Verdict"
printf '  passed: %s%d%s   warnings: %s%d%s   failures: %s%d%s\n' \
  "$c_green" "$PASS" "$c_reset" "$c_yellow" "$WARN" "$c_reset" "$c_red" "$FAIL" "$c_reset"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "  iGPU looks usable. Note the renderD128 GID above - the unprivileged LXC"
  echo "  needs that group mapped through for QSV/VAAPI to work inside it."
elif [ "$FAIL" -gt 0 ]; then
  echo "  Blocking problems found. Most common causes, in order:"
  echo "    1. iGPU disabled in BIOS (very common when a discrete GPU is present)"
  echo "    2. i915 blacklisted, left over from a previous GPU-passthrough setup"
  echo "    3. CPU genuinely has no iGPU (an 'F' suffix, or most Xeons)"
  echo
  echo "  None of these block the project - trim/join needs no GPU at all."
  echo "  You would lose only faster thumbnail scanning and future preview transcoding."
fi
echo
