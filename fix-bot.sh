#!/bin/sh
cd /var/www/projects/emoji_bot

echo "🔧 Исправление бота..."
echo ""

# 1. Проверяем статус PM2
echo "1. Статус PM2 процессов:"
pm2 list
echo ""

# 2. Перезапускаем процесс
echo "2. Перезапускаю emoji_bot_web..."
pm2 restart emoji_bot_web
sleep 3
echo ""

# 3. Проверяем логи
echo "3. Последние логи (30 строк):"
pm2 logs emoji_bot_web --lines 30 --nostream 2>&1 | tail -40
echo ""

# 4. Проверяем webhook
echo "4. Проверяю настройку webhook..."
echo "Выполните вручную для проверки webhook:"
echo "cd /var/www/projects/emoji_bot"
echo "pnpm set:webhook"
echo ""
echo "Или через npm:"
echo "cd /var/www/projects/emoji_bot"
echo "npm run set:webhook"
echo ""

# 5. Проверяем переменные окружения
echo "5. Переменные окружения в PM2:"
pm2 show emoji_bot_web | grep -A 20 "env:" | head -10
echo ""

echo "✅ Проверка завершена"
echo ""
echo "Если бот всё ещё не отвечает:"
echo "1. Проверьте что webhook настроен: npm run set:webhook"
echo "2. Проверьте логи: pm2 logs emoji_bot_web"
echo "3. Проверьте что сервер доступен: curl http://localhost:3000/api/tg/webhook"

