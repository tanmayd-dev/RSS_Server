#!/usr/bin/env bash
# Install the RSS Aggregator server as a systemd *user* service.
#
# Usage: systemd/install.sh
#
# Then:  systemctl enable --now --user rss-server
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/systemd/rss-server.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/rss-server.service"

if [ ! -f "$TEMPLATE" ]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

# The server must be built and the DB migrated before the service can run.
if [ ! -f "$REPO_DIR/dist/index.js" ]; then
  echo "error: backend not built — run 'npm install && npm run build' in $REPO_DIR first" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/frontend/dist/index.html" ]; then
  echo "error: frontend not built — run 'npm install && npm run build' in $REPO_DIR/frontend first" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/.env" ]; then
  echo "warning: no .env in $REPO_DIR — creating one with the default DATABASE_URL"
  printf 'DATABASE_URL="file:./prisma/dev.db"\n' > "$REPO_DIR/.env"
fi

mkdir -p "$UNIT_DIR"
sed "s|@REPO_DIR@|$REPO_DIR|g" "$TEMPLATE" > "$UNIT_FILE"
echo "installed $UNIT_FILE"

systemctl daemon-reload --user
echo "done. Start it with: systemctl enable --now --user rss-server"
