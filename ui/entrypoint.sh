#!/bin/sh
# Renders the nginx config at start, so one image covers plain HTTP, HTTPS with
# your own certificates, a self-signed stand-in, and optional basic auth -
# without needing a different build for each combination.
set -eu

# Certificates you supply are read from a read-only mount; a generated
# throwaway one has to live somewhere writable inside the container.
CERT_DIR=/certs
SELF_DIR=/etc/nginx/selfsigned
CONF=/etc/nginx/conf.d/default.conf

# ---------------------------------------------------------------- basic auth
AUTH_BLOCK=""
if [ -n "${AUTH_USER:-}" ] && [ -n "${AUTH_PASS:-}" ]; then
  htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USER" "$AUTH_PASS" >/dev/null 2>&1
  AUTH_BLOCK='auth_basic "Web Video Editor"; auth_basic_user_file /etc/nginx/.htpasswd;'
  echo "entrypoint: basic auth enabled for user '$AUTH_USER'"
else
  echo "entrypoint: no basic auth (set AUTH_USER and AUTH_PASS to enable)"
fi

# ---------------------------------------------------------------- tls
TLS=0
if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
  TLS=1
  echo "entrypoint: using certificates from $CERT_DIR"
elif [ "${TLS_SELFSIGNED:-0}" = "1" ]; then
  mkdir -p "$SELF_DIR"
  if [ ! -f "$SELF_DIR/privkey.pem" ]; then
    # A self-signed certificate encrypts the connection but proves nothing about
    # who is on the other end. Fine behind a reverse proxy that terminates TLS
    # properly; browsers will still warn if you hit it directly.
    if openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout "$SELF_DIR/privkey.pem" -out "$SELF_DIR/fullchain.pem" \
        -subj "/CN=web-video-editor" 2>/tmp/openssl.err; then
      echo "entrypoint: generated a self-signed certificate"
    else
      echo "entrypoint: could not generate a certificate, serving plain HTTP:"
      sed 's/^/  /' /tmp/openssl.err
    fi
  fi
  if [ -f "$SELF_DIR/privkey.pem" ]; then
    CERT_DIR="$SELF_DIR"
    TLS=1
  fi
fi

# ---------------------------------------------------------------- config
# The /api block is shared by both listeners. Video is served through here, so
# buffering stays off and Range headers must reach the backend intact.
API_BLOCK=$(cat <<API
    # Liveness probe: no data, no auth. The installer and any uptime monitor
    # need to reach it without credentials.
    location = /api/health {
        proxy_pass http://api:8080;
        proxy_set_header Host \$host;
        access_log off;
    }

    location /api/ {
        $AUTH_BLOCK
        proxy_pass http://api:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;

        proxy_set_header Range \$http_range;
        proxy_set_header If-Range \$http_if_range;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 0;
    }
API
)

SITE_BLOCK=$(cat <<SITE
    root /usr/share/nginx/html;
    index index.html;

    location / {
        $AUTH_BLOCK
        try_files \$uri \$uri/ /index.html;
    }

$API_BLOCK
SITE
)

# ---------------------------------------------------------------- phone site
# The phone UI is a SEPARATE front end (ui/phone.html), not a responsive mode
# of the desktop one, so it gets its own port rather than a path: a phone has a
# bare host:port to type, and nothing done for touch can affect the desktop
# app. Both come out of the same bundle; only which index.html is served
# differs.
PHONE_PORT="${PHONE_PORT:-8081}"

PHONE_BLOCK=$(cat <<PHONE
    root /usr/share/nginx/html;
    index phone.html;

    location / {
        $AUTH_BLOCK
        try_files \$uri \$uri/ /phone.html;
    }

$API_BLOCK
PHONE
)

{
  echo "server {"
  echo "    listen 80;"
  echo "    server_name _;"
  if [ "$TLS" = "1" ] && [ "${FORCE_HTTPS:-0}" = "1" ]; then
    # Only when asked: a forced redirect is wrong behind a proxy that already
    # terminates TLS and talks to this over plain HTTP.
    echo "    return 301 https://\$host\$request_uri;"
    echo "}"
    echo "server {"
    echo "    listen 80;"
    echo "    server_name localhost;"
  fi
  echo "$SITE_BLOCK"
  echo "}"

  echo "server {"
  echo "    listen $PHONE_PORT;"
  echo "    server_name _;"
  echo "$PHONE_BLOCK"
  echo "}"

  if [ "$TLS" = "1" ]; then
    echo "server {"
    echo "    listen 443 ssl;"
    echo "    http2 on;"
    echo "    server_name _;"
    echo "    ssl_certificate     $CERT_DIR/fullchain.pem;"
    echo "    ssl_certificate_key $CERT_DIR/privkey.pem;"
    echo "    ssl_protocols TLSv1.2 TLSv1.3;"
    echo "    ssl_prefer_server_ciphers off;"
    echo "$SITE_BLOCK"
    echo "}"
  fi
} > "$CONF"

# nginx resolves upstream hostnames once, at startup, and refuses to start if
# the name does not resolve yet. compose's depends_on only waits for the api
# container to be created, not for its DNS entry to exist - so without this the
# ui container would fail its config test and sit in a restart loop, which looks
# exactly like a broken config rather than a race.
i=0
while [ "$i" -lt 30 ]; do
  if getent hosts api >/dev/null 2>&1; then
    break
  fi
  [ "$i" = "0" ] && echo "entrypoint: waiting for the api container to get a DNS entry"
  i=$((i + 1))
  sleep 1
done
getent hosts api >/dev/null 2>&1 || echo "entrypoint: api still unresolved; starting anyway so the error is visible"

nginx -t
exec nginx -g 'daemon off;'
