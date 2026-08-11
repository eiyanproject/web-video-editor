#!/usr/bin/env bash
#
# Web Video Editor - installer and updater.
#
# The same script does both. Run it once to install; run it again to update.
# Updating pulls the latest code, rebuilds and restarts. Your settings, shares
# and stored credentials live in ./config and are never touched.
#
#   curl -fsSL https://raw.githubusercontent.com/eiyanproject/web-video-editor/main/install.sh | bash
#   ./install.sh --port 9000
#   ./install.sh --uninstall
#
set -euo pipefail

REPO_URL="https://github.com/eiyanproject/web-video-editor.git"
DEFAULT_DIR="/opt/web-video-editor"
DIR=""
PORT=""
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
    --port)      PORT="${2:-}"; shift 2 ;;
    --no-pull)   DO_PULL=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
# config/ holds settings.json with SMB credentials. It is gitignored and must
# survive every update - this is the whole reason updates are safe to re-run.
mkdir -p config
chmod 700 config 2>/dev/null || true
if [ -f config/settings.json ]; then
  ok "existing settings preserved ($(wc -c < config/settings.json) bytes)"
else
  ok "fresh install - no settings yet, you will be prompted in the UI"
fi

if [ -n "$PORT" ]; then
  if grep -q '^PORT=' .env 2>/dev/null; then
    sed -i "s/^PORT=.*/PORT=$PORT/" .env
  else
    echo "PORT=$PORT" >> .env
  fi
  ok "port set to $PORT"
fi
[ -f .env ] || echo "PORT=8088" > .env
EFF_PORT="$(grep '^PORT=' .env | cut -d= -f2)"

# ---------------------------------------------------------------- build & run
say "Building (first run compiles Rust - several minutes)"
$DC build

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
printf '   http://%s:%s\n\n' "$IP" "$EFF_PORT"
echo "   Installed at : $DIR"
echo "   Settings     : $DIR/config/settings.json (0600, keep it private)"
echo "   Update       : re-run this script"
echo "   Logs         : $DC logs -f api"
echo
echo "It starts with no storage configured. Open the page and connect a network"
echo "share - the empty state walks you through it."
echo
