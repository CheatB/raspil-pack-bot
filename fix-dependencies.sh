#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔧 Установка зависимостей..."
echo ""

# Проверяем наличие pnpm
if command -v pnpm >/dev/null 2>&1; then
    echo "✅ Найден pnpm, устанавливаю зависимости..."
    pnpm install
elif [ -f ~/.local/share/pnpm/pnpm ]; then
    echo "✅ Найден pnpm в ~/.local/share/pnpm, устанавливаю зависимости..."
    ~/.local/share/pnpm/pnpm install
elif [ -f /usr/local/bin/pnpm ]; then
    echo "✅ Найден pnpm в /usr/local/bin, устанавливаю зависимости..."
    /usr/local/bin/pnpm install
else
    echo "⚠️  pnpm не найден, использую npm..."
    echo "Устанавливаю зависимости через npm..."
    npm install
    echo ""
    echo "Устанавливаю зависимости в apps/web..."
    cd apps/web && npm install && cd ../..
fi

echo ""
echo "🔨 Пересобираю проект..."
if command -v pnpm >/dev/null 2>&1 || [ -f ~/.local/share/pnpm/pnpm ] || [ -f /usr/local/bin/pnpm ]; then
    NODE_OPTIONS='--max-old-space-size=1536' pnpm build
else
    NODE_OPTIONS='--max-old-space-size=1536' npm run build
fi

echo ""
echo "🚀 Перезапускаю PM2 процесс..."
pm2 restart emoji_bot_web
sleep 3

echo ""
echo "✅ Проверка статуса:"
pm2 list
echo ""
echo "📋 Последние логи:"
pm2 logs emoji_bot_web --lines 10 --nostream 2>&1 | tail -15

