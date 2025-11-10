import { Telegraf, Context, Markup } from 'telegraf';
import { Update, Message } from 'telegraf/typings/core/types/typegram';
import pino from 'pino';
import axios from 'axios';

const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
});

export type BotContext = Context<Update>;

// Menu keyboard
const mainMenu = Markup.keyboard([
  ['🎨 Сгенерировать пак'],
  ['💰 Тарифы', '📜 История'],
  ['❓ Помощь'],
]).resize();

// Store pending previews (userId -> { messageId, padding, grid, fileUrl })
const pendingPreviews = new Map<
  number,
  { messageId: number; padding: number; grid: { rows: number; cols: number }; fileUrl: string; userId: bigint }
>();

let botInstance: Telegraf | null = null;
let apiBaseUrl = '';
let internalKey = '';
let botToken = '';

/**
 * Initialize bot
 */
export function initBot(token: string, baseUrl: string, key: string): void {
  botToken = token;
  apiBaseUrl = baseUrl;
  internalKey = key;
  botInstance = new Telegraf(token);

  // Commands
  botInstance.command('start', handleStart);
  botInstance.action(/^pad:(\d+)$/, handlePaddingChange);
  botInstance.action('next', handleNext);
  botInstance.hears('🎨 Сгенерировать пак', handleGenerate);
  botInstance.hears('💰 Тарифы', handleTariffs);
  botInstance.hears('📜 История', handleHistory);
  botInstance.hears('❓ Помощь', handleHelp);

  // Media handlers
  botInstance.on('photo', handlePhoto);
  botInstance.on('video', handleVideo);
  botInstance.on('animation', handleAnimation);

  // Error handling
  botInstance.catch((err, ctx) => {
    logger.error({ err, userId: ctx.from?.id }, 'Bot error');
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
  });
}

/**
 * Handle Telegram update
 */
export async function handleUpdate(update: Update): Promise<void> {
  if (!botInstance) {
    throw new Error('Bot not initialized. Call initBot first.');
  }
  await botInstance.handleUpdate(update);
}

async function handleStart(ctx: BotContext) {
  const userId = ctx.from?.id;
  if (!userId) return;

  logger.info({ userId }, 'User started bot');

  await ctx.reply(
    '👋 Добро пожаловать в "Распил Пак"!\n\n' +
      'Я помогу создать эмодзи-пак из ваших изображений.\n\n' +
      'Используйте меню для навигации.',
    mainMenu
  );
}

async function handleGenerate(ctx: BotContext) {
  await ctx.reply(
    '📸 Отправьте изображение (PNG, JPG, WEBP)\n\n' +
      'Бот создаст превью мозаики с автоматической сеткой (9-15 тайлов).\n\n' +
      '💡 Free: до 5 обработок/месяц\n' +
      '⚡ Pro/Max: больше возможностей',
    Markup.removeKeyboard()
  );
}

async function handleTariffs(ctx: BotContext) {
  await ctx.reply(
    '💰 <b>Тарифы</b>\n\n' +
      '🆓 <b>Free</b>\n' +
      '• До 5 обработок/месяц\n' +
      '• Только изображения\n\n' +
      '⭐ <b>Pro</b>\n' +
      '• До 50 обработок/месяц\n' +
      '• Изображения + видео\n\n' +
      '🚀 <b>Max</b>\n' +
      '• До 200 обработок/месяц\n' +
      '• Все возможности\n\n' +
      '💳 Оплата будет доступна в следующем обновлении.',
    { parse_mode: 'HTML', ...mainMenu }
  );
}

async function handleHistory(ctx: BotContext) {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const response = await axios.get(`${apiBaseUrl}/api/history/list`, {
      params: { userId },
      headers: {
        'X-Internal-Key': internalKey,
      },
    });

    if (response.data.success && response.data.data.length > 0) {
      const packs = response.data.data;
      const message =
        '📜 <b>История ваших паков:</b>\n\n' +
        packs
          .slice(0, 10)
          .map(
            (pack: any, idx: number) =>
              `${idx + 1}. ${pack.kind === 'STATIC' ? '🖼️' : '🎬'} ${pack.gridRows}×${pack.gridCols} (${pack.tilesCount} тайлов) - ${new Date(pack.createdAt).toLocaleDateString('ru-RU')}`
          )
          .join('\n');

      await ctx.reply(message, { parse_mode: 'HTML', ...mainMenu });
    } else {
      await ctx.reply(
        '📜 История ваших паков:\n\nПока пусто. Создайте первый пак!',
        mainMenu
      );
    }
  } catch (error: any) {
    logger.error({ err: error, userId }, 'History fetch error');
    await ctx.reply('❌ Не удалось загрузить историю. Попробуйте позже.', mainMenu);
  }
}

async function handleHelp(ctx: BotContext) {
  await ctx.reply(
    '❓ <b>Помощь</b>\n\n' +
      '1. Нажмите "🎨 Сгенерировать пак"\n' +
      '2. Отправьте изображение\n' +
      '3. Получите превью мозаики\n' +
      '4. Настройте паддинг (отступы между тайлами)\n' +
      '5. Нажмите "Дальше" для сохранения\n\n' +
      '💡 <b>Важно:</b>\n' +
      '• Кастомные эмодзи требуют Telegram Premium\n' +
      '• Free: до 5 обработок/мес\n' +
      '• Pro/Max: больше возможностей\n\n' +
      'Сборка реального эмодзи-пака будет доступна в следующем обновлении.',
    { parse_mode: 'HTML', ...mainMenu }
  );
}

async function handlePhoto(ctx: BotContext) {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message || !('photo' in ctx.message)) return;

  const photo = ctx.message.photo;
  const largestPhoto = photo[photo.length - 1];

  // Check file size (max 10MB)
  if (largestPhoto.file_size && largestPhoto.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  const fileId = largestPhoto.file_id;

  await ctx.reply('📸 Обрабатываю изображение...', Markup.removeKeyboard());

  try {
    // Get file info from Telegram
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    // Request preview from API (quota will be checked and incremented there)
    let previewResponse;
    try {
      previewResponse = await axios.post(
        `${apiBaseUrl}/api/process/preview`,
        {
          userId: BigInt(userId),
          fileUrl,
          padding: 2,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': internalKey,
          },
        }
      );
    } catch (previewError: any) {
      // If quota limit exceeded, show error
      if (previewError.response?.status === 429) {
        await ctx.reply(
          `❌ ${previewError.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
          mainMenu
        );
        return;
      }
      throw previewError;
    }

    const { previewDataUrl, suggestedGrid, tilesCount } = previewResponse.data;

    // Convert base64 data URL to Buffer
    const base64Data = previewDataUrl.split(',')[1];
    const previewBuffer = Buffer.from(base64Data, 'base64');

    // Send preview with inline buttons
    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback('Паддинг -', 'pad:0'),
        Markup.button.callback('Паддинг +', 'pad:4'),
      ],
      [Markup.button.callback('Дальше', 'next')],
    ]);

    const sentMessage = await ctx.replyWithPhoto(
      { source: previewBuffer },
      {
        caption: `✅ Превью мозаики\nСетка: ${suggestedGrid.rows}×${suggestedGrid.cols} (${tilesCount} тайлов)\nПаддинг: 2px`,
        ...buttons,
      }
    );

    // Store pending preview
    pendingPreviews.set(userId, {
      messageId: sentMessage.message_id,
      padding: 2,
      grid: suggestedGrid,
      fileUrl,
      userId: BigInt(userId),
    });
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Photo processing error');
    await ctx.reply(
      '❌ Произошла ошибка при обработке изображения. Попробуйте позже.',
      mainMenu
    );
  }
}

async function handlePaddingChange(ctx: BotContext) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const match = ctx.match;
  if (!match || typeof match[1] !== 'string') return;

  const newPadding = parseInt(match[1], 10);
  const pending = pendingPreviews.get(userId);

  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.');
    return;
  }

  await ctx.answerCbQuery('Обновляю превью...');

  try {
    // Request new preview with updated padding
    const previewResponse = await axios.post(
      `${apiBaseUrl}/api/process/preview`,
      {
        userId: pending.userId,
        fileUrl: pending.fileUrl,
        padding: newPadding,
        width: undefined,
        height: undefined,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': internalKey,
        },
      }
    );

    const { previewDataUrl } = previewResponse.data;
    const base64Data = previewDataUrl.split(',')[1];
    const previewBuffer = Buffer.from(base64Data, 'base64');

    // Update buttons based on padding
    let padButtons;
    if (newPadding === 0) {
      padButtons = [
        [Markup.button.callback('Паддинг +', 'pad:2')],
        [Markup.button.callback('Дальше', 'next')],
      ];
    } else if (newPadding === 2) {
      padButtons = [
        [
          Markup.button.callback('Паддинг -', 'pad:0'),
          Markup.button.callback('Паддинг +', 'pad:4'),
        ],
        [Markup.button.callback('Дальше', 'next')],
      ];
    } else if (newPadding === 4) {
      padButtons = [
        [
          Markup.button.callback('Паддинг -', 'pad:2'),
          Markup.button.callback('Паддинг +', 'pad:6'),
        ],
        [Markup.button.callback('Дальше', 'next')],
      ];
    } else {
      padButtons = [
        [Markup.button.callback('Паддинг -', 'pad:4')],
        [Markup.button.callback('Дальше', 'next')],
      ];
    }

    // Update message
    await ctx.editMessageMedia(
      {
        type: 'photo',
        media: { source: previewBuffer },
        caption: `✅ Превью мозаики\nСетка: ${pending.grid.rows}×${pending.grid.cols} (${pending.grid.rows * pending.grid.cols} тайлов)\nПаддинг: ${newPadding}px`,
      },
      Markup.inlineKeyboard(padButtons)
    );

    // Update pending preview
    pendingPreviews.set(userId, {
      ...pending,
      padding: newPadding,
    });
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Padding change error');
    await ctx.answerCbQuery('Ошибка при обновлении превью');
  }
}

async function handleNext(ctx: BotContext) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const pending = pendingPreviews.get(userId);

  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.');
    return;
  }

  await ctx.answerCbQuery('Сохранение...');

  try {
    // Save pack (minimal record for now)
    await axios.post(
      `${apiBaseUrl}/api/packs/create`,
      {
        userId: pending.userId,
        kind: 'STATIC',
        gridRows: pending.grid.rows,
        gridCols: pending.grid.cols,
        padding: pending.padding,
        tilesCount: pending.grid.rows * pending.grid.cols,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': internalKey,
        },
      }
    );

    await ctx.editMessageCaption(
      '✅ Превью готово!\n\nОк, превью сохранено. Сборка реального эмодзи-пака будет доступна в следующем обновлении.',
      Markup.inlineKeyboard([])
    );

    pendingPreviews.delete(userId);
    await ctx.reply('Используйте меню для новых операций.', mainMenu);
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Pack save error');
    await ctx.answerCbQuery('Ошибка при сохранении');
  }
}

async function handleVideo(ctx: BotContext) {
  await ctx.reply('🎥 Обработка видео пока не поддерживается. Используйте изображения.', mainMenu);
}

async function handleAnimation(ctx: BotContext) {
  await ctx.reply('🎬 Обработка GIF пока не поддерживается. Используйте изображения.', mainMenu);
}
