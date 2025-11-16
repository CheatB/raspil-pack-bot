#!/bin/bash
# Скрипт для настройки dev окружения на сервере

set -e

PROJECT_ROOT="/var/www/projects/emoji_bot"
cd "$PROJECT_ROOT"

echo "🚀 Настройка dev окружения для emoji_bot..."

# 1. Проверяем наличие .env.local
if [ ! -f ".env.local" ]; then
    echo "📝 Создаю .env.local из .env.prod..."
    cp .env.prod .env.local
    # Заменяем production URL на dev
    sed -i 's|APP_BASE_URL=.*|APP_BASE_URL=http://localhost:3000|' .env.local
    sed -i 's|NODE_ENV=.*|NODE_ENV=development|' .env.local
    echo "✅ .env.local создан"
else
    echo "✅ .env.local уже существует"
fi

# 2. Синхронизируем .env.local в apps/web
echo "📋 Синхронизирую .env.local в apps/web..."
./scripts/sync-env.sh

# 3. Устанавливаем зависимости
echo "📦 Устанавливаю зависимости..."
pnpm install

# 4. Генерируем Prisma клиент
echo "🔧 Генерирую Prisma клиент..."
pnpm prisma:generate

# 5. Применяем миграции (если нужно)
echo "🗄️  Проверяю миграции..."
if [ -f "prisma/dev.db" ]; then
    echo "✅ dev.db уже существует"
else
    echo "📝 Применяю миграции..."
    pnpm prisma:migrate || echo "⚠️  Миграции могут быть уже применены"
fi

# 6. Собираем проект
echo "🔨 Собираю проект..."
pnpm -C apps/tg-bot build:prod
NODE_OPTIONS='--max-old-space-size=1536' pnpm -C apps/web build

echo "✅ Dev окружение настроено!"
echo ""
echo "Для запуска dev сервера:"
echo "  pnpm dev"
echo ""
echo "Для запуска через PM2 (dev режим):"
echo "  pm2 start ecosystem.config.js --env development"

