#!/usr/bin/env bash
# Sets up a fresh Ubuntu or Debian VPS to host Gentifi businesses at mcp.gentifi.com.
# Run as root:  bash setup-vps.sh
# Before running: point mcp.gentifi.com (an A record) at this server's IP address.
set -euo pipefail

echo "== Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

echo "== Gentifi user, toolkit and businesses folder"
id gentifi >/dev/null 2>&1 || useradd --system --home /srv/gentifi --shell /usr/sbin/nologin gentifi
mkdir -p /srv/gentifi/businesses
if [ -d /srv/gentifi/toolkit/.git ]; then
  git -C /srv/gentifi/toolkit pull --ff-only
else
  git clone https://github.com/SelfBankt/gentifi-toolkit.git /srv/gentifi/toolkit
fi
chown -R gentifi:gentifi /srv/gentifi

echo "== Services"
cp /srv/gentifi/toolkit/deploy/gentifi-host.service /etc/systemd/system/gentifi-host.service
cp /srv/gentifi/toolkit/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now gentifi-host
systemctl reload caddy || systemctl restart caddy

if command -v ufw >/dev/null; then ufw allow 80/tcp; ufw allow 443/tcp; fi

echo "== Done. Check: curl https://mcp.gentifi.com/healthz"
echo "Add a business: copy its folder (with gentifi.json) into /srv/gentifi/businesses/<slug>/"
echo "and chown -R gentifi:gentifi it. It goes live within 10 minutes, or run: systemctl restart gentifi-host"
