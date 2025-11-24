# Исправление проблемы с отсутствующими зависимостями

## Проблема:
```
Error: Cannot find module '/var/www/projects/emoji_bot/apps/web/node_modules/next/dist/bin/next'
```

## Решение:

### Вариант 1: Использовать скрипт (рекомендуется)

```bash
cd /var/www/projects/emoji_bot
chmod +x fix-dependencies.sh
./fix-dependencies.sh
```

### Вариант 2: Вручную

```bash
cd /var/www/projects/emoji_bot

# Найти pnpm
which pnpm
# или
~/.local/share/pnpm/pnpm --version
# или
/usr/local/bin/pnpm --version

# Если pnpm найден:
pnpm install

# Если pnpm не найден, используйте npm:
npm install

# Пересобрать проект
NODE_OPTIONS='--max-old-space-size=1536' pnpm build
# или
NODE_OPTIONS='--max-old-space-size=1536' npm run build

# Перезапустить PM2
pm2 restart emoji_bot_web
pm2 save
```

### Вариант 3: Установить pnpm глобально (если его нет)

```bash
# Установить pnpm через npm
npm install -g pnpm

# Затем выполнить:
cd /var/www/projects/emoji_bot
pnpm install
NODE_OPTIONS='--max-old-space-size=1536' pnpm build
pm2 restart emoji_bot_web
```

## После установки зависимостей:

1. Проверьте статус: `pm2 list`
2. Проверьте логи: `pm2 logs emoji_bot_web --lines 20`
3. Настройте webhook: `pnpm set:webhook` или `npm run set:webhook`

