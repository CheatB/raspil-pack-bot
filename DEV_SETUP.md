# Dev окружение и процесс разработки

## Текущее состояние

✅ **Бот работает на VPS сервере** (`https://raspil-pack.duckdns.org`)
✅ **Next.js запущен через PM2** (порт 3000)
✅ **Webhook переключен с Vercel на VPS**
✅ **Улучшено логирование ошибок**

## Процесс разработки

### Автоматизированный workflow

Используйте скрипт для автоматизации процесса:
```bash
cd /var/www/projects/emoji_bot
./scripts/dev-workflow.sh
```

Скрипт выполняет:
1. Проверку изменений
2. Добавление в git
3. Коммит (с запросом сообщения)
4. Push в репозиторий
5. Пересборку проекта
6. Перезапуск PM2 процессов

### Ручной процесс

Если нужно выполнить шаги вручную:

```bash
cd /var/www/projects/emoji_bot

# 1. Внести изменения в код

# 2. Добавить изменения
git add .

# 3. Закоммитить
git commit -m "Описание изменений"

# 4. Отправить в git
git push origin main

# 5. Пересобрать
pnpm -C apps/tg-bot build:prod
pnpm -C apps/web build

# 6. Перезапустить процессы
pm2 restart emoji_bot_web
pm2 restart emoji_bot
```

## Настройка dev окружения

### Первоначальная настройка

```bash
cd /var/www/projects/emoji_bot
./scripts/dev-setup.sh
```

### Запуск dev сервера

```bash
# Локальный dev сервер (для тестирования)
pnpm dev

# Или через PM2 (production-like)
pm2 start ecosystem.config.js --env development
```

## Проверка работы

### Статус процессов
```bash
pm2 list
pm2 logs emoji_bot_web --lines 50
pm2 logs emoji_bot --lines 50
```

### Проверка webhook
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### Тестирование API
```bash
# Проверка webhook endpoint
curl -X POST http://localhost:3000/api/tg/webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" \
  -d '{"update_id":1,"message":{"message_id":1,"from":{"id":123},"chat":{"id":123},"text":"/start"}}'
```

## Известные проблемы и исправления

### 1. Ошибка "Internal error" при создании эмодзипака
✅ **Исправлено**: Улучшено логирование в `apps/web/src/app/api/packs/create/route.ts`
- Теперь логируется детальная информация об ошибках
- В dev режиме показывается сообщение об ошибке

### 2. Ошибка при загрузке GIF/видео
✅ **Улучшено**: Добавлено детальное логирование ошибок
- Проверьте логи PM2 для деталей: `pm2 logs emoji_bot_web`

### 3. Переменные окружения
✅ **Исправлено**: `start.ts` теперь правильно использует переменные из PM2

## Структура PM2

Процессы в PM2:
- `emoji_bot_web` - Next.js веб-сервер (порт 3000)
- `emoji_bot` - Telegram бот процесс (для webhook режима)

## Переменные окружения

Все переменные заданы в `ecosystem.config.js`:
- `TG_BOT_TOKEN` - токен Telegram бота
- `WEBHOOK_SECRET` - секрет для webhook
- `APP_BASE_URL` - URL сервера
- `INTERNAL_KEY` - ключ для внутренних API
- `DATABASE_URL` - путь к базе данных

## Полезные команды

```bash
# Просмотр логов
pm2 logs emoji_bot_web --lines 100
pm2 logs emoji_bot --lines 100

# Перезапуск всех процессов
pm2 restart all

# Остановка процессов
pm2 stop all

# Удаление процессов
pm2 delete all

# Сохранение конфигурации PM2
pm2 save

# Автозапуск при перезагрузке
pm2 startup
```

## Что нужно для тестирования

1. **FFmpeg** - для обработки видео/GIF (проверьте: `ffmpeg -version`)
2. **Sharp** - для обработки изображений (установлен через npm)
3. **База данных SQLite** - должна быть доступна по пути из `DATABASE_URL`
4. **Публичный URL** - для webhook (сейчас используется `https://raspil-pack.duckdns.org`)

## Следующие шаги

1. Протестировать создание эмодзипака из изображения
2. Протестировать обработку GIF/видео
3. Проверить логи при ошибках для детальной диагностики
4. При необходимости добавить больше логирования





