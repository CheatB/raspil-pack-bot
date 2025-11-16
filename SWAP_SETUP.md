# Настройка Swap-файла

Для стабильной работы сборки Next.js на VPS с 2GB RAM рекомендуется создать swap-файл.

## Быстрая установка

```bash
sudo bash /var/www/projects/emoji_bot/scripts/setup-swap.sh
```

## Ручная установка

```bash
# Создать swap-файл 2GB
sudo fallocate -l 2G /swapfile

# Установить правильные права
sudo chmod 600 /swapfile

# Создать swap-область
sudo mkswap /swapfile

# Активировать swap
sudo swapon /swapfile

# Добавить в fstab для автозагрузки
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Проверка

```bash
# Проверить, что swap активен
swapon --show

# Проверить использование памяти
free -h
```

## Лимиты памяти Node.js

Лимиты памяти для сборки уже настроены в:
- `package.json` - `NODE_OPTIONS='--max-old-space-size=1536'`
- `apps/web/package.json` - `NODE_OPTIONS='--max-old-space-size=1536'`
- `scripts/dev-workflow.sh` - использует лимит 1536MB

Это оставляет ~400MB для системы и других процессов.
