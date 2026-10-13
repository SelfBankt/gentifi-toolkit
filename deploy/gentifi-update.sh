#!/usr/bin/env bash
# Updates the Gentifi toolkit on this VPS and restarts the host, then checks it's healthy.
# Installed as /usr/local/bin/gentifi-update by install-tools.sh. Run as root: gentifi-update
set -euo pipefail
TOOLKIT=/srv/gentifi/toolkit
before=$(runuser -u gentifi -- git -C "$TOOLKIT" rev-parse --short HEAD)
runuser -u gentifi -- git -C "$TOOLKIT" pull --ff-only -q
after=$(runuser -u gentifi -- git -C "$TOOLKIT" rev-parse --short HEAD)
# Refresh these helper commands too, replacing the files rather than writing into them
for name in update stats backup; do
  install -m 755 "$TOOLKIT/deploy/gentifi-$name.sh" "/usr/local/bin/gentifi-$name.new"
  mv -f "/usr/local/bin/gentifi-$name.new" "/usr/local/bin/gentifi-$name"
done
systemctl restart gentifi-host
for _ in $(seq 1 20); do
  if health=$(curl -fsS http://127.0.0.1:8787/healthz 2>/dev/null); then
    echo "Updated $before -> $after. Host is healthy: $health"
    exit 0
  fi
  sleep 1
done
echo "Updated $before -> $after, but the host isn't answering. Recent log:" >&2
journalctl -u gentifi-host -n 30 --no-pager >&2
exit 1
