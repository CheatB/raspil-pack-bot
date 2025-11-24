# 🚀 Быстрое исправление - выполните эти команды:

```bash
cd /var/www/projects/emoji_bot

# 1. Установить pnpm (проект использует pnpm workspace, npm не работает!)
npm install -g pnpm

# 2. Установить зависимости
pnpm install

# 3. Пересобрать проект
NODE_OPTIONS='--max-old-space-size=1536' pnpm build

# 4. Перезапустить PM2 (ВАЖНО: из корня проекта!)
cd /var/www/projects/emoji_bot
pm2 delete emoji_bot_web
pm2 start ecosystem.config.js
pm2 save

# 5. Настроить webhook
pnpm set:webhook

# 6. Проверить статус
pm2 list
pm2 logs emoji_bot_web --lines 20
```

## Или используйте скрипт:

```bash
cd /var/www/projects/emoji_bot
chmod +x FINAL_FIX.sh
./FINAL_FIX.sh
```

## Почему npm не работает?

Проект использует **pnpm workspace** с зависимостями типа `workspace:*`. 
npm не поддерживает этот протокол, поэтому нужен pnpm.

После установки pnpm всё должно заработать!

