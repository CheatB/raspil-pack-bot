# Инструкция по исправлению

## Текущая ситуация:
- ✅ `emoji_bot_web` работает (online)
- ❌ `emoji_bot` в статусе errored (но он не нужен в webhook режиме)
- ⚠️ `pnpm` не найден в PATH

## Что нужно сделать:

### 1. Найти pnpm или использовать npm:

```bash
# Проверьте где установлен pnpm:
which pnpm
~/.local/share/pnpm/pnpm --version
/usr/local/bin/pnpm --version

# Или используйте npm (если pnpm недоступен):
cd /var/www/projects/emoji_bot/apps/tg-bot
npm run build:prod
cd ../..
```

### 2. Удалить процесс emoji_bot (он не нужен):

```bash
pm2 delete emoji_bot
pm2 save
```

### 3. Проверить что всё работает:

```bash
pm2 list
pm2 logs emoji_bot_web --lines 20
```

## Или выполните обновлённый скрипт:

```bash
cd /var/www/projects/emoji_bot
chmod +x restore.sh
./restore.sh
```

Процесс `emoji_bot` не нужен в webhook режиме - бот обрабатывается через Next.js API route `/api/tg/webhook`.

