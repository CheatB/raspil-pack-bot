#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔍 Проверка статуса бота..."
echo ""

echo "1. Статус PM2 процессов:"
pm2 list
echo ""

echo "2. Последние логи emoji_bot_web (20 строк):"
pm2 logs emoji_bot_web --lines 20 --nostream 2>&1 | tail -30
echo ""

echo "3. Проверка webhook URL:"
echo "APP_BASE_URL: ${APP_BASE_URL:-не установлен}"
echo "WEBHOOK_SECRET: ${WEBHOOK_SECRET:+установлен}"
echo ""

echo "4. Проверка доступности API:"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3000/api/tg/webhook || echo "API недоступен"
echo ""

echo "5. Проверка переменных окружения в PM2:"
pm2 show emoji_bot_web | grep -E "TG_BOT_TOKEN|APP_BASE_URL|WEBHOOK_SECRET" | head -3
echo ""

echo "✅ Диагностика завершена"

