#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔍 Диагностика бота..."
echo "=================================="
echo ""

# 1. Проверка PM2
echo "1️⃣  Статус PM2 процессов:"
pm2 list
echo ""

# 2. Проверка логов
echo "2️⃣  Последние ошибки из логов:"
pm2 logs emoji_bot_web --err --lines 20 --nostream 2>&1 | tail -25
echo ""

echo "3️⃣  Последние логи (обычные):"
pm2 logs emoji_bot_web --lines 15 --nostream 2>&1 | tail -20
echo ""

# 3. Проверка переменных окружения
echo "4️⃣  Переменные окружения:"
pm2 show emoji_bot_web 2>&1 | grep -E "TG_BOT_TOKEN|APP_BASE_URL|WEBHOOK_SECRET|DATABASE_URL" | head -5
echo ""

# 4. Проверка доступности API
echo "5️⃣  Проверка доступности API:"
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost:3000/api/tg/webhook || echo "❌ API недоступен"
echo ""

# 5. Проверка webhook в Telegram
echo "6️⃣  Проверка webhook (нужен TG_BOT_TOKEN):"
if [ -n "$TG_BOT_TOKEN" ]; then
    echo "Проверяю webhook через Telegram API..."
    curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool 2>/dev/null || echo "Не удалось проверить webhook"
else
    echo "⚠️  TG_BOT_TOKEN не установлен в окружении"
    echo "Проверьте переменные в PM2: pm2 show emoji_bot_web"
fi
echo ""

echo "=================================="
echo "✅ Диагностика завершена"
echo ""
echo "Рекомендации:"
echo "1. Если есть ошибки в логах - исправьте их"
echo "2. Если webhook не настроен - выполните: npm run set:webhook (или pnpm set:webhook)"
echo "3. Если API недоступен - проверьте что процесс запущен: pm2 restart emoji_bot_web"
echo "4. Проверьте логи в реальном времени: pm2 logs emoji_bot_web"

