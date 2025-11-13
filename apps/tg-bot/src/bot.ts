import { Telegraf, Context, Markup, Input } from 'telegraf';
import type { Update, CallbackQuery } from 'telegraf/types';
import axios from 'axios';
import pino from 'pino';

export type BotContext = Context<Update>;

type CallbackQueryWithData = Extract<CallbackQuery, { data: string }>;

interface PendingPreview {
  messageId: number;
  padding: number;
  grid: { rows: number; cols: number };
  fileUrl: string;
  userId: bigint;
}

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

const mainMenu = Markup.keyboard([
  ['🎨 Сгенерировать пак'],
  ['💰 Тарифы', '📜 История'],
  ['❓ Помощь'],
]).resize();

const pendingPreviews = new Map<number, PendingPreview>();

let botInstance: Telegraf<BotContext> | null = null;
let apiBaseUrl = '';
let internalKey = '';
let botToken = '';

export function initBot(token: string, baseUrl: string, key: string): void {
  botToken = token;
  apiBaseUrl = baseUrl;
  internalKey = key;

  botInstance = new Telegraf<BotContext>(token);

  botInstance.command('start', handleStart);
  botInstance.hears('🎨 Сгенерировать пак', handleGenerate);
  botInstance.hears('💰 Тарифы', handleTariffs);
  botInstance.hears('📜 История', handleHistory);
  botInstance.hears('❓ Помощь', handleHelp);

  botInstance.on('photo', handlePhoto);
  botInstance.on('video', handleVideo);
  botInstance.on('animation', handleAnimation);
  botInstance.on('callback_query', handleCallbackQuery);

  botInstance.catch((err, ctx) => {
    logger.error({ err, userId: ctx.from?.id }, 'Bot error');
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
  });
}

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

  if (largestPhoto.file_size && largestPhoto.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  await ctx.reply('📸 Обрабатываю изображение...', Markup.removeKeyboard());

  try {
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${largestPhoto.file_id}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

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
    const base64Data = previewDataUrl.split(',')[1];
    const previewBuffer = Buffer.from(base64Data, 'base64');

    const caption =
      `✅ Превью мозаики\n` +
      `Сетка: ${suggestedGrid.rows}×${suggestedGrid.cols} (${tilesCount} тайлов)\n` +
      `Паддинг: 2px`;

    const sentMessage = await ctx.replyWithPhoto(Input.fromBuffer(previewBuffer), {
      caption,
      reply_markup: createPaddingKeyboard(2).reply_markup,
    });

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

async function handleCallbackQuery(ctx: BotContext) {
  const query = ctx.callbackQuery;

  if (!query) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  if (!hasCallbackData(query)) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  if (query.data.startsWith('padding_')) {
    await handlePaddingChange(ctx, query);
    return;
  }

  if (query.data === 'next') {
    await handleNext(ctx, query);
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
}

function hasCallbackData(query: CallbackQuery): query is CallbackQueryWithData {
  return typeof (query as CallbackQueryWithData).data === 'string';
}

export async function handlePaddingChange(
  ctx: BotContext,
  query: CallbackQueryWithData
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const newPadding = Number.parseInt(query.data.replace('padding_', ''), 10);
  if (!Number.isFinite(newPadding) || ![0, 2, 4].includes(newPadding)) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const pending = pendingPreviews.get(userId);
  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.').catch(() => {});
    return;
  }

  if (pending.padding === newPadding) {
    await ctx.answerCbQuery('Этот паддинг уже применён.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Обновляю превью...').catch(() => {});

  try {
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

    const caption =
      `✅ Превью мозаики\n` +
      `Сетка: ${pending.grid.rows}×${pending.grid.cols} (${pending.grid.rows * pending.grid.cols} тайлов)\n` +
      `Паддинг: ${newPadding}px`;

    await ctx.editMessageMedia(
      {
        type: 'photo',
        media: Input.fromBuffer(previewBuffer),
        caption,
        parse_mode: 'HTML',
      },
      {
        reply_markup: createPaddingKeyboard(newPadding).reply_markup,
      }
    );

    pendingPreviews.set(userId, {
      ...pending,
      padding: newPadding,
    });

    await ctx.answerCbQuery('Готово!').catch(() => {});
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Padding change error');
    const message =
      error?.response?.data?.error ?? 'Ошибка при обновлении превью. Попробуйте позже.';
    await ctx.answerCbQuery(message.substring(0, 200)).catch(() => {});
  }
}

function createPaddingKeyboard(currentPadding: number) {
  const availablePaddings = [0, 2, 4] as const;
  let currentIndex = availablePaddings.indexOf(
    currentPadding as (typeof availablePaddings)[number]
  );

  if (currentIndex === -1) {
    currentIndex = availablePaddings.indexOf(2);
  }

  const controls = [];

  if (currentIndex > 0) {
    controls.push(
      Markup.button.callback('Паддинг -', `padding_${availablePaddings[currentIndex - 1]}`)
    );
  }

  if (currentIndex < availablePaddings.length - 1) {
    controls.push(
      Markup.button.callback('Паддинг +', `padding_${availablePaddings[currentIndex + 1]}`)
    );
  }

  if (controls.length === 0) {
    controls.push(Markup.button.callback('Паддинг 2', 'padding_2'));
  }

  return Markup.inlineKeyboard([
    controls,
    [Markup.button.callback('Дальше', 'next')],
  ]);
}

async function handleNext(ctx: BotContext, _query: CallbackQueryWithData) {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const pending = pendingPreviews.get(userId);
  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Сохранение...').catch(() => {});

  try {
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
    await ctx.answerCbQuery('Ошибка при сохранении').catch(() => {});
  }
}

async function handleVideo(ctx: BotContext) {
  await ctx.reply('🎥 Обработка видео пока не поддерживается. Используйте изображения.', mainMenu);
}

async function handleAnimation(ctx: BotContext) {
  await ctx.reply('🎬 Обработка GIF пока не поддерживается. Используйте изображения.', mainMenu);
}

