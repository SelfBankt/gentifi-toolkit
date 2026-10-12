#!/usr/bin/env bash
# Puts the fictional Hollow Lane Farm Shop live at https://mcp.gentifi.com/b/demo-business/
# Run as root on the VPS:  bash /srv/gentifi/toolkit/deploy/add-demo.sh
set -euo pipefail
cd /srv/gentifi/toolkit
git pull --ff-only
mkdir -p /srv/gentifi/businesses/demo-business
node bin/gentifi.js init --force --from csv --file examples/demo-farm-shop.csv \
  --name "Hollow Lane Farm Shop" --kind "Farm shop" \
  --description "A fictional farm shop, used to demonstrate Gentifi." \
  --area BS --email orders@hollowlane.example --hours "Tu-Sa 09:00-17:00" --order reserve \
  --base-url https://mcp.gentifi.com/b/demo-business \
  --project /srv/gentifi/businesses/demo-business/gentifi.json
node bin/gentifi.js check --project /srv/gentifi/businesses/demo-business/gentifi.json | tail -2
chown -R gentifi:gentifi /srv/gentifi/businesses
systemctl restart gentifi-host
sleep 2
curl -s http://127.0.0.1:8787/healthz; echo
echo "Live at https://mcp.gentifi.com/b/demo-business/"
