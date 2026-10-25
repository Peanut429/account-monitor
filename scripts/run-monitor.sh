#!/bin/zsh
set -euo pipefail

cd /Users/fuhui/outsourcing-projects/changan-monitor
export PATH="/Users/fuhui/.nvm/versions/node/v24.19.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p logs
exec /opt/homebrew/bin/pnpm run monitor >> logs/monitor.log 2>&1
