#!/usr/bin/env bash
#
# Web Video Editor - installer and updater.
#
# The same script does both. Run it once to install; run it again to update.
# Updating pulls the latest code, rebuilds and restarts. Your settings, shares,
# stored credentials and saved cut lists are never touched.
#
# Serves on port 80 by default, so the bare IP works with no port to remember.
#
#   curl -fsSL https://raw.githubusercontent.com/eiyanproject/web-video-editor/main/install.sh | bash
#   ./install.sh --port 8088                 # somewhere else
#   ./install.sh --phone-port 8081           # the phone UI's own port
#   ./install.sh --auth me:secret            # basic auth, for anything reachable
#   ./install.sh --self-signed               # TLS on 443 with a throwaway cert
#   ./install.sh --uninstall
#
# For real HTTPS, drop fullchain.pem and privkey.pem into ./certs and re-run.
# Behind a reverse proxy, leave TLS to the proxy and point it at port 80.
#
set -euo pipefail

REPO_URL="https://github.com/eiyanproject/web-video-editor.git"
DEFAULT_DIR="/opt/web-video-editor"
DIR=""
PORT=""
HTTPS_PORT=""
PHONE_PORT=""
AUTH=""
SELF_SIGNED=""
DO_PULL=1
UNINSTALL=0

c_g=$'\033[32m'; c_y=$'\033[33m'; c_r=$'\033[31m'; c_b=$'\033[1m'; c_0=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_b" "$c_0" "$1"; }
ok()   { printf '  %s✓%s %s\n' "$c_g" "$c_0" "$1"; }
warn() { printf '  %s!%s %s\n' "$c_y" "$c_0" "$1"; }
die()  { printf '  %s✗%s %s\n' "$c_r" "$c_0" "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       DIR="${2:-}"; shift 2 ;;
    --port|--http-port) PORT="${2:-}"; shift 2 ;;
    --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --phone-port) PHONE_PORT="${2:-}"; shift 2 ;;
    --auth)      AUTH="${2:-}"; shift 2 ;;
    --no-auth)   AUTH="none"; shift ;;
    --self-signed) SELF_SIGNED=1; shift ;;
    --no-pull)   DO_PULL=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- prerequisites
say "Checking prerequisites"

if ! command -v docker >/dev/null 2>&1; then
  die "docker is not installed. On Debian/Ubuntu:
      curl -fsSL https://get.docker.com | sh"
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "the Docker Compose plugin is missing. On Debian/Ubuntu:
      apt-get install -y docker-compose-plugin"
fi
ok "docker and compose present"

if ! docker info >/dev/null 2>&1; then
  die "cannot talk to the Docker daemon. Start it, or re-run with sudo."
fi
ok "docker daemon reachable"

command -v git >/dev/null 2>&1 || die "git is not installed."

# ---------------------------------------------------------------- locate source
# Running from inside a clone? Use that, so a developer's working tree is never
# silently replaced by a fresh clone somewhere else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$DIR" ]; then
  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/.git" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
    DIR="$SCRIPT_DIR"
  else
    DIR="$DEFAULT_DIR"
  fi
fi

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  say "Uninstalling"
  [ -f "$DIR/docker-compose.yml" ] || die "no installation found at $DIR"
  (cd "$DIR" && $DC down) || true
  ok "containers stopped and removed"
  warn "kept your settings at $DIR/config - delete it by hand if you want them gone"
  warn "kept the analysis cache at $DIR/cache - safe to delete, it rebuilds itself"
  warn "saved cut lists are wherever you pointed them, usually on the share, and are untouched"
  exit 0
fi

# ---------------------------------------------------------------- fetch
if [ -d "$DIR/.git" ]; then
  say "Updating existing installation at $DIR"
  if [ "$DO_PULL" -eq 1 ]; then
    if [ -n "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]; then
      warn "local changes present - skipping pull so nothing is overwritten"
      warn "commit or stash them, or re-run with --no-pull to silence this"
    else
      BEFORE="$(git -C "$DIR" rev-parse --short HEAD)"
      git -C "$DIR" pull --ff-only
      AFTER="$(git -C "$DIR" rev-parse --short HEAD)"
      if [ "$BEFORE" = "$AFTER" ]; then ok "already up to date ($AFTER)"
      else ok "updated $BEFORE -> $AFTER"; fi
    fi
  fi
else
  say "Installing to $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO_URL" "$DIR"
  ok "cloned"
fi

cd "$DIR"

# ---------------------------------------------------------------- config
# Both bind mounts must exist before compose starts, or Docker creates them
# owned by root and the container cannot write to them - which shows up much
# later as a baffling permission error on an export.
#
# config/ holds settings.json with SMB credentials and must survive every
# update; that is the whole reason re-running this is safe. cache/ holds
# analysis results (probe, keyframe index, thumbnails) and is regenerable, so
# losing it costs time rather than data.
mkdir -p config cache
chmod 700 config 2>/dev/null || true
if [ -f config/settings.json ]; then
  ok "existing settings preserved ($(wc -c < config/settings.json) bytes)"
else
  ok "fresh install - no settings yet, you will be prompted in the UI"
fi
CACHE_SIZE="$(du -sh cache 2>/dev/null | cut -f1)"
[ -n "$CACHE_SIZE" ] && ok "analysis cache: $CACHE_SIZE"

# Saved cut lists live wherever you pointed them - usually on the share, so
# they travel with the media rather than with this install.
EDITS_DIR="$(sed -n 's/.*"edits_dir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' config/settings.json 2>/dev/null | head -1)"
[ -n "$EDITS_DIR" ] && ok "saved cut lists: $EDITS_DIR (untouched)"

touch .env
set_env () {   # set_env KEY VALUE - replaces or appends, never duplicates
  if grep -q "^$1=" .env 2>/dev/null; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
get_env () { grep "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- ; }

[ -n "$PORT" ] && { set_env HTTP_PORT "$PORT"; ok "http port set to $PORT"; }
[ -n "$HTTPS_PORT" ] && { set_env HTTPS_PORT "$HTTPS_PORT"; ok "https port set to $HTTPS_PORT"; }
[ -n "$PHONE_PORT" ] && { set_env PHONE_PORT "$PHONE_PORT"; ok "phone ui port set to $PHONE_PORT"; }
[ -n "$SELF_SIGNED" ] && { set_env TLS_SELFSIGNED 1; ok "self-signed TLS enabled"; }

case "$AUTH" in
  none) set_env AUTH_USER ""; set_env AUTH_PASS ""; warn "basic auth disabled" ;;
  ?*:?*)
    set_env AUTH_USER "${AUTH%%:*}"
    set_env AUTH_PASS "${AUTH#*:}"
    chmod 600 .env 2>/dev/null || true
    ok "basic auth enabled for ${AUTH%%:*}"
    ;;
  ?*) die "--auth expects user:password" ;;
esac

# Defaults, only filled in if absent, so a re-run never resets your choices.
grep -q '^HTTP_PORT='  .env || set_env HTTP_PORT 80
grep -q '^HTTPS_PORT=' .env || set_env HTTPS_PORT 443
# The phone UI is a separate front end on its own port. It is baked into the
# desktop bundle's link at build time, so changing it needs a rebuild - which
# is exactly what a re-run of this script does.
grep -q '^PHONE_PORT=' .env || set_env PHONE_PORT 8081
EFF_PORT="$(get_env HTTP_PORT)"
EFF_TLS_PORT="$(get_env HTTPS_PORT)"
mkdir -p certs

# Port 80 is the default because typing a bare IP is the point, but it is also
# the port a reverse proxy on the same host will already be using.
if [ "$EFF_PORT" = "80" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -qE '[^0-9]:80[[:space:]]'; then
    warn "something is already listening on port 80 on this host"
    warn "if that is your reverse proxy, run: ./install.sh --port 8088 and point the proxy at it"
  fi
fi

if [ -z "$(get_env AUTH_USER)" ]; then
  warn "no login is set: anyone who can reach this can browse and export from your shares"
  warn "before exposing it beyond the LAN, run: ./install.sh --auth user:password"
fi

# ---------------------------------------------------------------- build & run
say "Building (first run compiles Rust - several minutes)"
$DC build

# Containers carry fixed names, so one left behind by an older layout blocks the
# new one with a name conflict rather than being replaced. Clear any that are
# not part of this compose project.
for c in wve-api wve-ui; do
  if docker container inspect "$c" >/dev/null 2>&1; then
    OWNER="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$c" 2>/dev/null || true)"
    if [ "$OWNER" != "web-video-editor" ]; then
      docker rm -f "$c" >/dev/null 2>&1 || true
      ok "removed a stray $c from an earlier install"
    fi
  fi
done

say "Starting"
$DC up -d

# ---------------------------------------------------------------- verify
say "Verifying"
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${EFF_PORT}/api/health" >/dev/null 2>&1; then
    ok "API responding"
    break
  fi
  [ "$i" -eq 30 ] && { warn "API did not respond within 60s"; warn "check: $DC logs api"; }
  sleep 2
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="localhost"

echo
printf '%sWeb Video Editor is running.%s\n\n' "$c_g$c_b" "$c_0"
if [ "$EFF_PORT" = "80" ]; then
  printf '   http://%s\n' "$IP"
else
  printf '   http://%s:%s\n' "$IP" "$EFF_PORT"
fi
if [ -f certs/fullchain.pem ] || [ "$(get_env TLS_SELFSIGNED)" = "1" ]; then
  if [ "$EFF_TLS_PORT" = "443" ]; then printf '   https://%s\n' "$IP"
  else printf '   https://%s:%s\n' "$IP" "$EFF_TLS_PORT"; fi
fi
echo
echo "   Installed at : $DIR"
echo "   Settings     : $DIR/config/settings.json (0600, keep it private)"
echo "   Cache        : $DIR/cache (analysis results, safe to delete)"
if [ -n "$(get_env AUTH_USER)" ]; then
  LOGIN_DESC="basic auth as $(get_env AUTH_USER)"
else
  LOGIN_DESC="none - anyone who can reach it gets in"
fi
if [ -f certs/fullchain.pem ]; then
  TLS_DESC="certificates in ./certs"
elif [ "$(get_env TLS_SELFSIGNED)" = "1" ]; then
  TLS_DESC="self-signed"
else
  TLS_DESC="off - put certs in ./certs, or terminate TLS at your proxy"
fi
echo "   Login        : $LOGIN_DESC"
echo "   TLS          : $TLS_DESC"
echo "   Update       : re-run this script"
echo "   Logs         : $DC logs -f api, or the Log page in the app"
echo
echo "It starts with no storage configured. Open the page and connect a network"
echo "share - the empty state walks you through it. Press ? in the app for the"
echo "keyboard shortcuts."
echo
