#!/bin/sh
# Простой скрипт для исправления - выполните: chmod +x FIX_NOW.sh && ./FIX_NOW.sh

cd /var/www/projects/emoji_bot

echo "🔧 Шаг 1: Установка зависимостей в корне..."
npm install

echo ""
echo "🔧 Шаг 2: Установка зависимостей в apps/web..."
cd apps/web
npm install
cd ../..

echo ""
echo "🔨 Шаг 3: Пересборка проекта..."
NODE_OPTIONS='--max-old-space-size=1536' npm run build

echo ""
echo "🚀 Шаг 4: Перезапуск PM2..."
pm2 delete emoji_bot_web 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "📡 Шаг 5: Настройка webhook..."
npm run set:webhook

echo ""
echo "✅ Готово! Проверьте статус:"
pm2 list
echo ""
echo "Проверьте логи: pm2 logs emoji_bot_web --lines 20"

