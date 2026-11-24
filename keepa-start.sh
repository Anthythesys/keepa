#!/bin/bash
# Keepa automatic setup: game server + Cloudflare tunnel forced onto wlan1.
#
#   sudo keepa-start.sh           one-shot setup, prints the tunnel URL
#   sudo keepa-start.sh --watch   setup + 60s watchdog (used by systemd)
#
# Safe to run repeatedly: everything is idempotent.

set -u

REPO=/home/bruno/keepa
APPUSER=bruno
LOGDIR=/tmp/opencode
SERVER_LOG="$LOGDIR/keepa.log"
TUNNEL_LOG="$LOGDIR/tunnel.log"
URL_FILE="$LOGDIR/keepa-url.txt"
STATE_FILE="$LOGDIR/.keepa-tunnel-url"
WLAN_MAIN=wlan0
WLAN_TUNNEL=wlan1
MARK=0x2
TABLE=102
INTERVAL=60

log() { printf '[keepa] %s\n' "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"
mkdir -p "$LOGDIR"

gw_of()    { ip -4 route show dev "$1" | awk '/^default /{print $3; exit}'; }
ip_of()    { ip -4 -o addr show dev "$1" | awk '{split($4,a,"/"); print a[1]; exit}'; }
subnet_of(){ ip -4 route show dev "$1" | awk '/scope link/{print $1; exit}'; }

# NetworkManager metric: persistent across reboots, so wlan0 stays the
# everyday default and wlan1 is only preferred by the marked tunnel.
set_nm_metric() {
  command -v nmcli >/dev/null 2>&1 || return 0
  local conn current
  conn=$(nmcli -g GENERAL.CONNECTION device show "$1" 2>/dev/null | head -1)
  [ -n "$conn" ] || return 0
  current=$(nmcli -g ipv4.route-metric connection show "$conn" 2>/dev/null | head -1)
  [ "$current" = "$2" ] || nmcli connection modify "$conn" ipv4.route-metric "$2" >/dev/null 2>&1 || true
}

ensure_user() {
  id cloudflared >/dev/null 2>&1 || \
    useradd -r -s /usr/sbin/nologin -d /nonexistent -c "cloudflared tunnel" cloudflared
}

setup_network() {
  local gw0 ip0 gw1 ip1 subnet
  gw0=$(gw_of "$WLAN_MAIN");    ip0=$(ip_of "$WLAN_MAIN")
  gw1=$(gw_of "$WLAN_TUNNEL");  ip1=$(ip_of "$WLAN_TUNNEL")
  subnet=$(subnet_of "$WLAN_TUNNEL")
  [ -n "$gw0" ] && [ -n "$ip0" ] && [ -n "$gw1" ] && [ -n "$ip1" ] && [ -n "$subnet" ] \
    || die "Wi-Fi not ready ($WLAN_MAIN / $WLAN_TUNNEL)"

  set_nm_metric "$WLAN_MAIN" 600
  set_nm_metric "$WLAN_TUNNEL" 900

  # Immediate correction for this boot (NM metric change alone isn't applied
  # until reconnect, so replace the live routes too).
  ip route show | grep -q "default via $gw0 dev $WLAN_MAIN.*metric 600" \
    || ip route replace default via "$gw0" dev "$WLAN_MAIN" src "$ip0" metric 600
  ip route show | grep -q "default via $gw1 dev $WLAN_TUNNEL.*metric 900" \
    || ip route replace default via "$gw1" dev "$WLAN_TUNNEL" src "$ip1" metric 900

  ensure_user

  # Mark only cloudflared's packets...
  iptables -t mangle -C OUTPUT -m owner --uid-owner cloudflared -j MARK --set-mark "$MARK" 2>/dev/null \
    || iptables -t mangle -A OUTPUT -m owner --uid-owner cloudflared -j MARK --set-mark "$MARK"
  # ...and give them a routing table that goes out wlan1.
  ip rule show | grep -q "fwmark $MARK lookup $TABLE" \
    || ip rule add prio 5000 fwmark "$MARK" lookup "$TABLE"

  if ! ip route show table "$TABLE" 2>/dev/null | grep -q "default via $gw1 dev $WLAN_TUNNEL" \
     || ! ip route show table "$TABLE" 2>/dev/null | grep -q "dev $WLAN_TUNNEL.*$ip1"; then
    ip route flush table "$TABLE" 2>/dev/null
    ip route add 127.0.0.0/8 dev lo table "$TABLE"
    ip route add "$subnet" dev "$WLAN_TUNNEL" src "$ip1" table "$TABLE"
    ip route add default via "$gw1" dev "$WLAN_TUNNEL" src "$ip1" table "$TABLE"
  fi
}

verify_url() {
  local url=$1 host ip tries
  host=${url#https://}; host=${host%/}
  for tries in $(seq 1 15); do
    curl -fsS -o /dev/null --max-time 10 "$url/" 2>/dev/null && return 0
    # Home routers can take a while to learn a fresh trycloudflare hostname.
    # Resolve via DNS-over-HTTPS and pin the IP so a good tunnel isn't
    # reported as broken just because the local resolver is behind.
    ip=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
      "https://cloudflare-dns.com/dns-query?name=$host&type=A" 2>/dev/null \
      | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$ip" ]; then
      curl -fsS -o /dev/null --max-time 10 --resolve "$host:443:$ip" "$url/" 2>/dev/null && return 0
    fi
    resolvectl flush-caches >/dev/null 2>&1 || true
    sleep 4
  done
  return 1
}

publish_url() {
  local url=$1 old
  old=$(cat "$STATE_FILE" 2>/dev/null || true)
  if [ "$old" != "$url" ]; then
    log "new tunnel URL — flushing DNS and verifying"
    resolvectl flush-caches >/dev/null 2>&1 || true
    verify_url "$url" || log "WARNING: $url not reachable yet (DNS propagation?)"
    printf '%s\n' "$url" > "$STATE_FILE"
    printf '%s\n' "$url" > "$URL_FILE"
  fi
  log "tunnel URL: $url"
}

start_server() {
  curl -fsS -o /dev/null --max-time 3 http://localhost:3000/ 2>/dev/null && return 0
  log "starting game server"
  setsid runuser -u "$APPUSER" -- env HOME="/home/$APPUSER" bash -c "cd '$REPO' && exec node server.js" \
    >>"$SERVER_LOG" 2>&1 </dev/null &
  local i
  for i in $(seq 1 20); do
    sleep 1
    curl -fsS -o /dev/null --max-time 2 http://localhost:3000/ 2>/dev/null && return 0
  done
  die "game server failed to start (see $SERVER_LOG)"
}

start_tunnel() {
  local url
  if pgrep -u cloudflared -f 'cloudflared tunnel --url' >/dev/null 2>&1; then
    url=$(grep -o 'https://[^ ]*trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$url" ]; then
      publish_url "$url"
      return 0
    fi
    log "tunnel running but no URL — restarting it"
    pkill -u cloudflared -f 'cloudflared tunnel --url' || true
    sleep 2
  fi

  log "starting cloudflare tunnel via $WLAN_TUNNEL"
  : > "$TUNNEL_LOG"
  setsid runuser -u cloudflared -- /usr/local/bin/cloudflared tunnel --url http://localhost:3000 \
    >>"$TUNNEL_LOG" 2>&1 </dev/null &
  local i
  for i in $(seq 1 45); do
    sleep 1
    url=$(grep -o 'https://[^ ]*trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    [ -n "$url" ] && break
  done
  [ -n "$url" ] || die "tunnel produced no URL (see $TUNNEL_LOG)"
  publish_url "$url"
}

setup_once() {
  setup_network
  start_server
  start_tunnel
}

if [ "${1:-}" = "--watch" ]; then
  log "watchdog mode — checking every ${INTERVAL}s"
  while true; do
    setup_once || log "setup failed; retrying in ${INTERVAL}s"
    sleep "$INTERVAL"
  done
else
  setup_once
  log "done. URL also saved to $URL_FILE"
fi
