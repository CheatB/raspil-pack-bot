#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔧 Финальное исправление проекта..."
echo ""

# 1. Установить pnpm глобально
echo "1️⃣  Устанавливаю pnpm..."
npm install -g pnpm

# 2. Установить зависимости через pnpm
echo ""
echo "2️⃣  Устанавливаю зависимости через pnpm..."
pnpm install

# 3. Пересобрать проект
echo ""
echo "3️⃣  Пересобираю проект..."
NODE_OPTIONS='--max-old-space-size=1536' pnpm build

# 4. Перезапустить PM2 (из корня проекта!)
echo ""
echo "4️⃣  Перезапускаю PM2..."
cd /var/www/projects/emoji_bot
pm2 delete emoji_bot_web 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# 5. Настроить webhook
echo ""
echo "5️⃣  Настраиваю webhook..."
pnpm set:webhook

echo ""
echo "✅ Готово! Проверьте статус:"
pm2 list
echo ""
echo "📋 Последние логи:"
pm2 logs emoji_bot_web --lines 15 --nostream 2>&1 | tail -20

