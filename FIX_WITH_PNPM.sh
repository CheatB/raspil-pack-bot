#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔧 Исправление проекта с pnpm..."
echo ""

# 1. Установить pnpm если его нет
if ! command -v pnpm >/dev/null 2>&1; then
    echo "📦 Устанавливаю pnpm..."
    npm install -g pnpm
fi

# 2. Установить зависимости
echo "📦 Устанавливаю зависимости..."
pnpm install

# 3. Пересобрать проект
echo "🔨 Пересобираю проект..."
NODE_OPTIONS='--max-old-space-size=1536' pnpm build

# 4. Перезапустить PM2
echo "🚀 Перезапускаю PM2..."
pm2 delete emoji_bot_web 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# 5. Настроить webhook
echo "📡 Настраиваю webhook..."
pnpm set:webhook

echo ""
echo "✅ Готово! Проверьте статус:"
pm2 list
echo ""
echo "Проверьте логи: pm2 logs emoji_bot_web --lines 20"

