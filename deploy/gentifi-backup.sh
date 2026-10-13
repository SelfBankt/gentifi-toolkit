#!/usr/bin/env bash
# Backs up every hosted business (gentifi.json, stats and tokens) to /srv/gentifi/backups,
# keeping 14 days. Run nightly by gentifi-backup.timer; run by hand any time: gentifi-backup
set -euo pipefail
DEST=/srv/gentifi/backups
install -d -m 700 "$DEST"
file="$DEST/businesses-$(date +%F).tar.gz"
tar -czf "$file.tmp" -C /srv/gentifi businesses
mv -f "$file.tmp" "$file"
find "$DEST" -name 'businesses-*.tar.gz' -mtime +14 -delete
echo "Backed up to $file ($(du -h "$file" | cut -f1))"
