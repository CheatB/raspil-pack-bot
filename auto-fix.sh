#!/bin/sh
set -e

cd /var/www/projects/emoji_bot

echo "🔧 Автоматическое исправление бота..."
echo ""

# 1. Установка зависимостей
echo "1️⃣  Устанавливаю зависимости..."
if command -v pnpm >/dev/null 2>&1; then
    echo "   Использую pnpm..."
    pnpm install
elif [ -f ~/.local/share/pnpm/pnpm ]; then
    echo "   Использую pnpm из ~/.local/share/pnpm..."
    ~/.local/share/pnpm/pnpm install
elif [ -f /usr/local/bin/pnpm ]; then
    echo "   Использую pnpm из /usr/local/bin..."
    /usr/local/bin/pnpm install
else
    echo "   pnpm не найден, использую npm..."
    npm install
    echo "   Устанавливаю зависимости в apps/web..."
    cd apps/web && npm install && cd ../..
fi

echo ""
echo "2️⃣  Пересобираю проект..."
if command -v pnpm >/dev/null 2>&1 || [ -f ~/.local/share/pnpm/pnpm ] || [ -f /usr/local/bin/pnpm ]; then
    NODE_OPTIONS='--max-old-space-size=1536' pnpm build
else
    NODE_OPTIONS='--max-old-space-size=1536' npm run build
fi

echo ""
echo "3️⃣  Перезапускаю PM2 процесс..."
pm2 restart emoji_bot_web || pm2 start ecosystem.config.js
sleep 3
pm2 save

echo ""
echo "4️⃣  Проверяю статус..."
pm2 list

echo ""
echo "5️⃣  Настраиваю webhook..."
if command -v pnpm >/dev/null 2>&1 || [ -f ~/.local/share/pnpm/pnpm ] || [ -f /usr/local/bin/pnpm ]; then
    pnpm set:webhook 2>&1 || echo "⚠️  Не удалось настроить webhook автоматически"
else
    npm run set:webhook 2>&1 || echo "⚠️  Не удалось настроить webhook автоматически"
fi

echo ""
echo "6️⃣  Последние логи (10 строк):"
pm2 logs emoji_bot_web --lines 10 --nostream 2>&1 | tail -15

echo ""
echo "✅ Готово! Проверьте статус: pm2 list"
echo "   Если процесс online - бот должен работать!"
echo "   Если нет - проверьте логи: pm2 logs emoji_bot_web"

