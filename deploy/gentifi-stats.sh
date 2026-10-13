#!/usr/bin/env bash
# Anonymous counts for every hosted business. Usage: gentifi-stats [--days 7] [--json]
exec runuser -u gentifi -- node /srv/gentifi/toolkit/bin/gentifi.js stats --dir /srv/gentifi/businesses "$@"
