#!/usr/bin/env bash
# Installs the Gentifi helper commands and nightly backups on a VPS already set up
# with setup-vps.sh. Touches nothing else (not Caddy, not other services).
# Run as root:  bash /srv/gentifi/toolkit/deploy/install-tools.sh
set -euo pipefail
DEPLOY=/srv/gentifi/toolkit/deploy
for name in update stats backup check; do
  install -m 755 "$DEPLOY/gentifi-$name.sh" "/usr/local/bin/gentifi-$name"
done
for unit in backup check; do
  install -m 644 "$DEPLOY/gentifi-$unit.service" "/etc/systemd/system/gentifi-$unit.service"
  install -m 644 "$DEPLOY/gentifi-$unit.timer" "/etc/systemd/system/gentifi-$unit.timer"
done
systemctl daemon-reload
systemctl enable --now gentifi-backup.timer gentifi-check.timer
/usr/local/bin/gentifi-backup
echo
echo "Installed:"
echo "  gentifi-update   pull the latest toolkit, restart the host and check it's healthy"
echo "  gentifi-stats    anonymous counts per business (add --days 7 for a week)"
echo "  gentifi-backup   back up the businesses folder now (also runs nightly, kept 14 days)"
echo "  gentifi-check    the daily check: running, problems, waiting orders, backups, counts"
echo "                   (sent to the team chat in Telegram every morning at 7.30)"
echo "Next backup: $(systemctl show gentifi-backup.timer -p NextElapseUSecRealtime --value)"
echo "Next check:  $(systemctl show gentifi-check.timer -p NextElapseUSecRealtime --value)"
