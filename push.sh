#!/usr/bin/env bash
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "GITHUB_TOKEN не установлен. Добавь export GITHUB_TOKEN=... в профиль и перезапусти shell."
  exit 1
fi

if git diff --quiet; then
  echo "Нет изменений — пуш не требуется."
  exit 0
fi

TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
COMMIT_MESSAGE="Auto commit: $TIMESTAMP"

git add .
git commit -m "$COMMIT_MESSAGE"

git remote set-url origin https://$GITHUB_TOKEN@github.com/CheatB/raspil-pack-bot.git
git push origin main
git remote set-url origin https://github.com/CheatB/raspil-pack-bot.git

echo "Готово: изменения отправлены в GitHub."
