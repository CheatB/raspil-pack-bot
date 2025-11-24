# Восстановление проекта

Все пути исправлены. Выполните следующие команды:

```bash
cd /var/www/projects/emoji_bot

# Пересобрать tg-bot (если нужно)
pnpm -C apps/tg-bot build:prod

# Запустить/перезапустить PM2 процессы
pm2 start ecosystem.config.js || pm2 restart emoji_bot_web
pm2 save

# Проверить статус
pm2 list
```

## Что было исправлено:

✅ `/var/www/projects/emoji_bot/apps/tg-bot/src/start.ts` - путь: `emoji_bot`  
✅ `/var/www/projects/emoji_bot/scripts/dev-setup.sh` - путь: `emoji_bot`  
✅ `/var/www/projects/emoji_bot/scripts/dev-workflow.sh` - путь: `emoji_bot`  
✅ `/var/www/projects/emoji_bot/ecosystem.config.js` - пути корректны  

## Альтернативный способ (через скрипт):

```bash
cd /var/www/projects/emoji_bot
chmod +x restore.sh
./restore.sh
```

Или через Node.js:

```bash
cd /var/www/projects/emoji_bot
node restore.js
```

