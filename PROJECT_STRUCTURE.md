# Структура проекта "Распил Пак"

```
Emoji_bot/
│
├── 📁 apps/                          # Приложения
│   │
│   ├── 📁 processor/                 # Обработка изображений (sharp)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── image.ts              # Функции обработки изображений
│   │       └── index.ts              # Экспорты
│   │
│   ├── 📁 tg-bot/                    # Telegram бот (core логика)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── bot.ts                # Основная логика бота
│   │   │   └── index.ts              # Экспорты
│   │   └── scripts/
│   │       └── setWebhook.ts         # Скрипт установки webhook
│   │
│   └── 📁 web/                       # Next.js приложение
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js            # Конфигурация Next.js
│       ├── .env.local                # Переменные окружения (локально)
│       └── src/
│           ├── app/
│           │   ├── layout.tsx        # Layout приложения
│           │   ├── page.tsx          # Главная страница
│           │   └── api/              # API маршруты
│           │       ├── tg/
│           │       │   └── webhook/
│           │       │       └── route.ts       # Webhook для Telegram
│           │       ├── process/
│           │       │   └── preview/
│           │       │       └── route.ts       # Обработка превью изображений
│           │       ├── packs/
│           │       │   └── create/
│           │       │       └── route.ts       # Создание пака
│           │       └── history/
│           │           └── list/
│           │               └── route.ts       # История паков
│           └── lib/                  # Утилиты
│               ├── bot-handler.ts    # Обработчик бота (перенесено из tg-bot)
│               ├── env.ts            # Загрузка переменных окружения
│               ├── logger.ts         # Логирование (Pino)
│               ├── prisma.ts         # Prisma клиент
│               └── quota.ts          # Управление квотами
│
├── 📁 packages/                      # Общие пакеты
│   │
│   ├── 📁 config/                    # Конфигурации (ESLint, TypeScript)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── eslint.config.js      # Конфигурация ESLint
│   │       ├── tsconfig.base.json    # Базовый tsconfig
│   │       └── index.ts              # Экспорты
│   │
│   └── 📁 types/                     # Общие типы и схемы
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── schemas.ts            # Zod схемы (env, metadata, etc.)
│           ├── interfaces.ts         # TypeScript интерфейсы
│           └── index.ts              # Экспорты
│
├── 📁 prisma/                        # База данных
│   ├── schema.prisma                 # Схема базы данных
│   ├── dev.db                        # SQLite база данных (dev)
│   └── migrations/                   # Миграции
│       └── 20251108105050_init/
│           └── migration.sql
│
├── 📁 scripts/                       # Скрипты
│   └── sync-env.sh                   # Синхронизация .env.local
│
├── 📄 package.json                   # Root package.json (monorepo)
├── 📄 pnpm-workspace.yaml            # Конфигурация pnpm workspace
├── 📄 tsconfig.json                  # Root TypeScript config
├── 📄 tsconfig.scripts.json          # TypeScript config для скриптов
├── 📄 vercel.json                    # Конфигурация Vercel
├── 📄 .env.local                     # Переменные окружения (root)
├── 📄 .nvmrc                         # Версия Node.js
├── 📄 .prettierrc                    # Конфигурация Prettier
├── 📄 .prettierignore                # Игнорируемые файлы для Prettier
├── 📄 .gitignore                     # Игнорируемые файлы для Git
├── 📄 README.md                      # Документация проекта
├── 📄 SETUP.md                       # Инструкции по настройке
└── 📄 STATUS.md                      # Статус проекта (если есть)

```

## Основные файлы

### Конфигурация
- `package.json` - зависимости и скрипты монorepo
- `pnpm-workspace.yaml` - конфигурация workspace
- `tsconfig.json` - базовые настройки TypeScript
- `vercel.json` - конфигурация деплоя на Vercel

### База данных
- `prisma/schema.prisma` - схема БД (User, Quota, Pack, Payment, Event)
- `prisma/migrations/` - миграции Prisma

### Приложения

#### `apps/web` (Next.js)
- API routes для обработки запросов
- Обработчик бота (перенесен из tg-bot для избежания проблем с импортом)
- Утилиты для работы с БД, квотами, логированием

#### `apps/processor` (Sharp)
- Обработка изображений
- Генерация мозаики превью
- Автоматический выбор сетки (9-15 тайлов)

#### `apps/tg-bot` (Telegraf)
- Основная логика бота
- Скрипты для настройки webhook

### Пакеты

#### `packages/types`
- Zod схемы для валидации
- TypeScript интерфейсы
- Общие типы

#### `packages/config`
- Конфигурации ESLint и TypeScript
- Базовые настройки для всех пакетов

### Скрипты
- `scripts/sync-env.sh` - синхронизация .env.local между корнем и apps/web

## Важные замечания

1. **`.env.local`** должен быть в двух местах:
   - Корень проекта (для скриптов)
   - `apps/web/.env.local` (для Next.js)

2. **Используйте `pnpm sync:env`** для синхронизации переменных окружения

3. **База данных** SQLite находится в `prisma/dev.db`

4. **Скомпилированные файлы** находятся в:
   - `apps/processor/dist/` (после build)
   - `apps/web/.next/` (Next.js build)

