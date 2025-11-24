#!/bin/sh
# Выполните этот скрипт: chmod +x EXECUTE_THIS.sh && ./EXECUTE_THIS.sh

cd /var/www/projects/emoji_bot

echo "🔧 Установка зависимостей..."
npm install
cd apps/web && npm install && cd ../..

echo "🔨 Пересборка проекта..."
NODE_OPTIONS='--max-old-space-size=1536' npm run build

echo "🚀 Перезапуск PM2..."
pm2 restart emoji_bot_web || pm2 start ecosystem.config.js
pm2 save

echo "📡 Настройка webhook..."
npm run set:webhook

echo "✅ Готово! Проверьте: pm2 list"

