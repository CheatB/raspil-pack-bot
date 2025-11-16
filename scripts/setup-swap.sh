#!/bin/bash
# Скрипт для создания swap-файла на VPS
# Требует sudo права

set -e

echo "🔧 Настройка swap-файла..."

# Проверяем, есть ли уже swap
if swapon --show | grep -q .; then
    echo "✅ Swap уже настроен:"
    swapon --show
    free -h
    exit 0
fi

# Создаем swap-файл 2GB
echo "📦 Создаю swap-файл 2GB..."
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Добавляем в fstab для автозагрузки
if ! grep -q "/swapfile" /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "✅ Swap добавлен в /etc/fstab"
fi

echo "✅ Swap-файл создан и активирован!"
echo ""
echo "📊 Текущее состояние памяти:"
free -h





