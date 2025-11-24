#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔨 Пересобираю tg-bot..."
# Пробуем найти pnpm в разных местах
if command -v pnpm >/dev/null 2>&1; then
    pnpm -C apps/tg-bot build:prod
elif [ -f ~/.local/share/pnpm/pnpm ]; then
    ~/.local/share/pnpm/pnpm -C apps/tg-bot build:prod
elif [ -f /usr/local/bin/pnpm ]; then
    /usr/local/bin/pnpm -C apps/tg-bot build:prod
else
    echo "⚠️  pnpm не найден, используем npm..."
    cd apps/tg-bot && npm run build:prod && cd ../..
fi

echo "🧹 Удаляю старый процесс emoji_bot (не нужен в webhook режиме)..."
pm2 delete emoji_bot 2>/dev/null || true

echo "🚀 Запускаю/перезапускаю PM2 процессы..."
pm2 start ecosystem.config.js 2>/dev/null || pm2 restart emoji_bot_web
pm2 save

echo "✅ Проект восстановлен!"
pm2 list

