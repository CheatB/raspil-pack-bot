#!/bin/bash
# Скрипт для синхронизации .env.local между корнем проекта и apps/web

ROOT_ENV=".env.local"
WEB_ENV="apps/web/.env.local"

if [ ! -f "$ROOT_ENV" ]; then
  echo "❌ Файл $ROOT_ENV не найден в корне проекта"
  exit 1
fi

# Копируем из корня в apps/web
cp "$ROOT_ENV" "$WEB_ENV"
echo "✅ .env.local синхронизирован: $ROOT_ENV -> $WEB_ENV"

# Обновляем APP_BASE_URL если передан как аргумент
if [ ! -z "$1" ]; then
  sed -i '' "s|APP_BASE_URL=.*|APP_BASE_URL=$1|" "$ROOT_ENV"
  sed -i '' "s|APP_BASE_URL=.*|APP_BASE_URL=$1|" "$WEB_ENV"
  echo "✅ APP_BASE_URL обновлен: $1"
fi

