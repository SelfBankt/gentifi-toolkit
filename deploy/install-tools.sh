#!/usr/bin/env bash
# Installs the Gentifi helper commands and nightly backups on a VPS already set up
# with setup-vps.sh. Touches nothing else (not Caddy, not other services).
# Run as root:  bash /srv/gentifi/toolkit/deploy/install-tools.sh
set -euo pipefail
DEPLOY=/srv/gentifi/toolkit/deploy
for name in update stats backup; do
  install -m 755 "$DEPLOY/gentifi-$name.sh" "/usr/local/bin/gentifi-$name"
done
install -m 644 "$DEPLOY/gentifi-backup.service" /etc/systemd/system/gentifi-backup.service
install -m 644 "$DEPLOY/gentifi-backup.timer" /etc/systemd/system/gentifi-backup.timer
systemctl daemon-reload
systemctl enable --now gentifi-backup.timer
/usr/local/bin/gentifi-backup
echo
echo "Installed:"
echo "  gentifi-update   pull the latest toolkit, restart the host and check it's healthy"
echo "  gentifi-stats    anonymous counts per business (add --days 7 for a week)"
echo "  gentifi-backup   back up the businesses folder now (also runs nightly, kept 14 days)"
echo "Next backup: $(systemctl show gentifi-backup.timer -p NextElapseUSecRealtime --value)"
