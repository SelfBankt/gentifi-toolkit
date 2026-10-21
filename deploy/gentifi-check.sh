#!/usr/bin/env bash
# The daily check: is everything running, did anything go wrong in the last day, are any
# orders waiting for an owner, are the backups fresh, and the counts. Changes nothing.
# Installed as /usr/local/bin/gentifi-check by install-tools.sh. Run as root: gentifi-check
set -uo pipefail
export TZ=Europe/London  # times as the shops see them
BOT_DB=${GENTIFI_RELAY_DB:-/var/lib/gentifi-bot/relay.db}
BACKUPS=/srv/gentifi/backups
problems=0
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; problems=$((problems + 1)); }
note() { printf '    %s\n' "$1"; }

echo "Gentifi daily check, $(date '+%a %-d %b %Y %H:%M')"

echo
echo "Running"
for unit in gentifi-host gentifi-bot caddy; do
  if systemctl is-active -q "$unit"; then
    ok "$unit, since $(systemctl show "$unit" -p ActiveEnterTimestamp --value | cut -d' ' -f2-3)"
  else
    bad "$unit is $(systemctl is-active "$unit"). Start it: systemctl restart $unit"
  fi
done
if health=$(curl -fsS -m 10 https://mcp.gentifi.com/healthz 2>/dev/null); then
  ok "mcp.gentifi.com answers: $(printf '%s' "$health" | sed -E 's/.*"businesses":([0-9]+).*/\1/') business(es) visible to customers' AI"
else
  bad "mcp.gentifi.com doesn't answer from outside"
fi
if [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gentifi.com/)" = 200 ]; then
  ok "gentifi.com answers"
else
  bad "gentifi.com doesn't answer"
fi

echo
echo "Last 24 hours"
pattern="fail|couldn't|error|unreachable|skipped|no usable|no linked owner"
for unit in gentifi-host gentifi-bot; do
  lines=$(journalctl -u "$unit" --since "-24h" --no-pager -o cat 2>/dev/null | grep -Ei "$pattern")
  if [ -z "$lines" ]; then
    ok "nothing wrong in $unit's log"
  else
    bad "$(printf '%s\n' "$lines" | wc -l | tr -d ' ') problem line(s) in $unit's log, latest:"
    printf '%s\n' "$lines" | tail -3 | cut -c1-160 | sed 's/^/      /'
  fi
done
restarts=$(journalctl -u gentifi-bot -u gentifi-host --since "-24h" --no-pager -o cat 2>/dev/null | grep -c "Main process exited")
[ "$restarts" -gt 0 ] && bad "a service crashed and restarted $restarts time(s): see journalctl -u gentifi-bot -u gentifi-host"

echo
echo "Orders and owners"
if [ -f "$BOT_DB" ]; then
  # Read-only. The bot's database never holds customers' names or contact details.
  python3 - "$BOT_DB" <<'PY' || bad "couldn't read the bot's database"
import json, sqlite3, sys
from datetime import datetime, timezone
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
if "orders" in tables:
    waiting, accepted = [], []
    for reference, record in db.execute("SELECT reference, record FROM orders ORDER BY created_at"):
        r = json.loads(record)
        status = r["receipt"]["status"]
        if status == "pending_confirmation":
            by = datetime.fromisoformat(r["receipt"]["confirm_by"]).astimezone().strftime("%H:%M %-d %b")
            waiting.append(f"{reference} for {r['business_id']}, answer by {by}")
        elif status in {"confirmed", "held"} and not r.get("forgotten"):
            accepted.append(f"{reference} for {r['business_id']}")
    print(f"  {'!' if waiting else '✓'} {len(waiting)} order(s) waiting for an owner to answer")
    for line in waiting:
        print(f"      {line}")
    print(f"  · {len(accepted)} accepted, not yet marked collected or done")
    for line in accepted:
        print(f"      {line}")
else:
    print("  · the bot doesn't keep orders yet: run gentifi-bot-update")
owners = db.execute("SELECT business_id, status FROM merchants WHERE chat_id IS NOT NULL ORDER BY business_id").fetchall()
live = [b for b, s in owners if s != "onboarding"]
onboarding = [b for b, s in owners if s == "onboarding"]
print(f"  · owners on Telegram: {len(live)} live" + (f" ({', '.join(live)})" if live else ""))
if onboarding:
    print(f"  · still checking their listing: {', '.join(onboarding)}")
PY
else
  bad "no bot database at $BOT_DB"
fi

echo
echo "Backups and disk"
for kind in businesses:gentifi-backup bot:gentifi-bot-backup; do
  name=${kind%%:*}
  newest=$(ls -t "$BACKUPS/$name"-* 2>/dev/null | head -1)
  if [ -n "$newest" ] && [ -n "$(find "$newest" -mtime -2)" ]; then
    ok "$name backup: $(basename "$newest")"
  else
    bad "no $name backup in the last two days. Run: ${kind#*:}"
  fi
done
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$used" -lt 85 ]; then ok "disk $used% used"; else bad "disk $used% used"; fi

echo
echo "Counts"
runuser -u gentifi -- node /srv/gentifi/toolkit/bin/gentifi.js stats --dir /srv/gentifi/businesses --days 2 2>/dev/null \
  | sed 's/^/  /' || note "couldn't read the counts"

echo
if [ "$problems" -eq 0 ]; then
  echo "All good."
else
  echo "$problems thing(s) to look at (marked ✗)."
fi
exit 0
