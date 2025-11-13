#!/bin/bash

set -e
PROJECT=$1
if [ -z "$PROJECT" ]; then
  echo "❌ Error: project name not provided"
  exit 1
fi
echo "🚀 Deploying $PROJECT ..."
ssh -t -t cursor@raspil-pack.duckdns.org << EOF
  set -e
  # === PNPM PATH FIX ===
  export PNPM_HOME="\$HOME/.local/share/pnpm"
  export PATH="\$PNPM_HOME:\$PATH"
  cd /var/www/projects/$PROJECT
  echo "📥 Pulling latest code..."
  git fetch --all
  git reset --hard origin/main
  echo "📦 Installing deps..."
  pnpm install
  echo "🔧 Building project..."
  pnpm run build > logs/build.log 2>&1
  echo "🔄 Restarting PM2..."
  pm2 restart $PROJECT || pm2 start apps/tg-bot/dist/index.js --name $PROJECT
  echo "📤 Showing last logs..."
  tail -n 50 logs/build.log
EOF
echo "✅ Deploy complete"
