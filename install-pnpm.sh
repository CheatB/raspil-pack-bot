#!/bin/sh
# Установка pnpm и исправление проекта

cd /var/www/projects/emoji_bot

echo "📦 Устанавливаю pnpm..."
npm install -g pnpm

echo ""
echo "🔧 Устанавливаю зависимости через pnpm..."
pnpm install

echo ""
echo "🔨 Пересобираю проект..."
NODE_OPTIONS='--max-old-space-size=1536' pnpm build

echo ""
echo "🚀 Запускаю PM2..."
cd /var/www/projects/emoji_bot
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "📡 Настраиваю webhook..."
pnpm set:webhook

echo ""
echo "✅ Готово!"
pm2 list

