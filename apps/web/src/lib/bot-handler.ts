import { logger } from './logger';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { prisma } from '@/lib/prisma';
import { isAdmin, grantSubscription, setAdmin, normalizeUsername } from '@/lib/admin';

// Lazy get env to avoid issues with Next.js module loading
function getEnv() {
  return {
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN!,
    APP_BASE_URL: process.env.APP_BASE_URL!,
    INTERNAL_KEY: process.env.INTERNAL_KEY!,
  };
}

interface PreviewOptions {
  userId: number;
  fileUrl: string;
  padding?: number;
  fileType?: 'image' | 'video' | 'animation';
  username?: string;
  captionPrefix?: string;
}

type GridOption = {
  rows: number;
  cols: number;
  tilesCount: number;
};

async function generatePreviewAndSend(ctx: any, options: PreviewOptions): Promise<boolean> {
  const { userId, fileUrl, padding = 0, fileType = 'image', username, captionPrefix } = options;
  const env = getEnv();
  const stopChatAction = startChatAction(
    ctx,
    fileType === 'video' || fileType === 'animation' ? 'upload_video' : 'upload_photo'
  );

  try {
    let previewResponse;

    try {
      previewResponse = await axios.post(
      `${env.APP_BASE_URL}/api/process/preview`,
      {
        userId: userId.toString(),
        fileUrl,
        padding,
        fileType,
        username,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_KEY,
        },
        timeout: 60000,
      }
    );
      logger.info({ userId, status: previewResponse.status }, 'Preview API response received');
    } catch (apiError: any) {
      logger.error({
        err: apiError,
        userId,
        fileUrl,
        response: apiError.response?.data,
        status: apiError.response?.status,
      }, 'Preview API call failed');

      if (apiError.response?.data?.error) {
        await ctx.reply(`❌ ${apiError.response.data.error}`, mainMenu);
      } else if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ETIMEDOUT') {
        await ctx.reply('❌ Сервер временно недоступен. Попробуйте позже.', mainMenu);
      } else if (apiError.response?.status === 429) {
        await ctx.reply(
          `❌ ${apiError.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
          mainMenu
        );
      } else {
        await ctx.reply('❌ Произошла ошибка при обработке. Попробуйте позже.', mainMenu);
      }
      return false;
    }

    if (previewResponse.data.error) {
      logger.error({ error: previewResponse.data.error, userId }, 'Preview API returned error');
      await ctx.reply(`❌ ${previewResponse.data.error}`, mainMenu);
      return false;
    }

    const {
      previewDataUrl,
      suggestedGrid,
      tilesCount,
      isVideo,
      gridOptions: rawGridOptions,
    } = previewResponse.data;
    if (!previewDataUrl) {
      logger.error({ responseData: previewResponse.data, userId }, 'No previewDataUrl in response');
      await ctx.reply('❌ Ошибка: превью не было создано.', mainMenu);
      return false;
    }

    const base64Data = previewDataUrl.split(',')[1];
    if (!base64Data) {
      logger.error({ previewDataUrl: previewDataUrl.substring(0, 50), userId }, 'Invalid previewDataUrl format');
      await ctx.reply('❌ Ошибка: неверный формат превью.', mainMenu);
      return false;
    }

    const previewBuffer = Buffer.from(base64Data, 'base64');

    const isVideoPreview = Boolean(isVideo);
    const captionHeader = captionPrefix ?? (isVideoPreview ? '📽️ Превью первого кадра' : '🖼️ Превью мозаики');
    const gridOptions: GridOption[] = sanitizeGridOptions(rawGridOptions);

    const caption = `${captionHeader}\nСетка: ${suggestedGrid.rows}×${suggestedGrid.cols} (${tilesCount} тайлов)\nПаддинг: ${padding}px`;

    const keyboard = buildPreviewKeyboard(suggestedGrid, padding, gridOptions);

    const sentMessage = await ctx.replyWithPhoto(
      { source: previewBuffer },
      {
        caption,
        ...keyboard,
      }
    );

    const userIdBigInt = BigInt(userId);

    lastMedia.set(userId, {
      fileUrl,
      fileType,
      isVideo: isVideoPreview,
      padding,
      grid: suggestedGrid,
      gridOptions,
    });

    try {
      await prisma.event.create({
        data: {
          userId: userIdBigInt,
          type: 'PREVIEW_SESSION',
          payload: JSON.stringify({
            messageId: sentMessage.message_id,
            padding,
            gridRows: suggestedGrid.rows,
            gridCols: suggestedGrid.cols,
            fileUrl,
            fileType,
            isVideo: isVideoPreview,
            gridOptions,
            createdAt: new Date().toISOString(),
          }),
        },
      });
      logger.info({ userId: userIdBigInt, messageId: sentMessage.message_id }, 'Preview session saved to DB');
    } catch (dbError: any) {
      logger.error({ err: dbError, userId: userIdBigInt }, 'Failed to save preview session to DB');
    }

    const pendingData = {
      messageId: sentMessage.message_id,
    padding,
      grid: suggestedGrid,
      fileUrl,
      userId: userIdBigInt,
      isVideo: isVideoPreview,
      fileType: (fileType ?? (isVideoPreview ? 'video' : 'image')) as 'image' | 'video' | 'animation',
      gridOptions,
    };

    pendingPreviews.set(userId, pendingData);

    return true;
  } finally {
    stopChatAction();
  }
}

// Menu keyboard
const mainMenu = Markup.keyboard([
  ['🎨 Сгенерировать пак'],
  ['💰 Тарифы', '📜 История'],
  ['❓ Помощь'],
]).resize();

type PendingPreview = {
  messageId: number;
  padding: number;
  grid: { rows: number; cols: number };
  fileUrl: string;
  userId: bigint;
  isVideo: boolean;
  fileType: 'image' | 'video' | 'animation';
  gridOptions?: GridOption[];
};

const pendingPreviews = new Map<number, PendingPreview>();

type LastMedia = {
  fileUrl: string;
  fileType: 'image' | 'video' | 'animation';
  isVideo: boolean;
  padding: number;
  grid?: { rows: number; cols: number };
  gridOptions?: GridOption[];
};

const lastMedia = new Map<number, LastMedia>();

let botInstance: Telegraf | null = null;
let initialized = false;

const GRID_MIN = 1;
const GRID_MAX = 15;
const PADDING_MIN = 0;
const PADDING_MAX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function startChatAction(ctx: any, action: string = 'typing'): () => void {
  let active = true;
  ctx.sendChatAction(action).catch(() => {});
  const interval = setInterval(() => {
    if (!active) return;
    ctx.sendChatAction(action).catch(() => {});
  }, 4000);

  return () => {
    active = false;
    clearInterval(interval);
  };
}

function sanitizeGridOptions(raw: any): GridOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const unique: GridOption[] = [];
  const seen = new Set<string>();

  for (const option of raw) {
    if (
      !Number.isFinite(option?.rows) ||
      !Number.isFinite(option?.cols) ||
      option.rows <= 0 ||
      option.cols <= 0
    ) {
      continue;
    }

    const rows = Number(option.rows);
    const cols = Number(option.cols);
    const key = `${rows}x${cols}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    unique.push({
      rows,
      cols,
      tilesCount: Number.isFinite(option.tilesCount)
        ? Number(option.tilesCount)
        : rows * cols,
    });
  }

  return unique
    .filter(
      (opt: any) =>
        Number.isFinite(opt?.rows) &&
        Number.isFinite(opt?.cols) &&
        opt.rows > 0 &&
        opt.cols > 0
    )
    .map((opt: any) => ({
      rows: Number(opt.rows),
      cols: Number(opt.cols),
      tilesCount: Number.isFinite(opt.tilesCount)
        ? Number(opt.tilesCount)
        : Number(opt.rows) * Number(opt.cols),
    }));
}

function buildPreviewKeyboard(
  grid: { rows: number; cols: number },
  padding: number,
  gridOptions: GridOption[] = []
) {
  const options: GridOption[] = (() => {
    const sanitized = gridOptions.length ? gridOptions : [];
    const hasCurrent = sanitized.some(
      (option) => option.rows === grid.rows && option.cols === grid.cols
    );
    if (hasCurrent) {
      return sanitized;
    }
    return [
      { rows: grid.rows, cols: grid.cols, tilesCount: grid.rows * grid.cols },
      ...sanitized,
    ];
  })();

  const optionButtons = options.map((option) => {
    const isActive = option.rows === grid.rows && option.cols === grid.cols;
    const label = `${isActive ? '✅ ' : ''}${option.rows}×${option.cols}`;
    return Markup.button.callback(label, `grid:set:${option.rows}x${option.cols}`);
  });

  const rows: any[] = [];

  if (optionButtons.length) {
    for (let i = 0; i < optionButtons.length; i += 3) {
      rows.push(optionButtons.slice(i, i + 3));
    }
  }

  rows.push([
    Markup.button.callback('⬅️ Паддинг -', 'pad:-'),
    Markup.button.callback('Паддинг + ➡️', 'pad:+'),
  ]);
  rows.push([Markup.button.callback('✨ Создать эмодзи-пак', 'makepack')]);

  return Markup.inlineKeyboard(rows);
}

async function restorePendingPreview(
  userId: number,
  userIdBigInt: bigint,
  messageId: number
): Promise<PendingPreview | null> {
  try {
    const events = await prisma.event.findMany({
      where: {
        userId: userIdBigInt,
        type: 'PREVIEW_SESSION',
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 5,
    });

    for (const event of events) {
      try {
        const eventData = JSON.parse(event.payload || '{}');
        if (eventData.messageId === messageId) {
          const pending: PendingPreview = {
            messageId,
            padding: Number.isFinite(eventData.padding) ? eventData.padding : 2,
            grid: {
              rows: clamp(Number(eventData.gridRows) || 3, GRID_MIN, GRID_MAX),
              cols: clamp(Number(eventData.gridCols) || 3, GRID_MIN, GRID_MAX),
            },
            fileUrl: eventData.fileUrl,
            userId: userIdBigInt,
            isVideo: Boolean(eventData.isVideo),
            fileType: (eventData.fileType ?? (eventData.isVideo ? 'video' : 'image')) as 'image' | 'video' | 'animation',
            gridOptions: sanitizeGridOptions(eventData.gridOptions),
          };
          pendingPreviews.set(userId, pending);
          logger.info({ userId, messageId }, 'Restored pending preview from DB');
          return pending;
        }
      } catch (parseError) {
        logger.error({ err: parseError, eventId: event.id }, 'Failed to parse preview event payload');
      }
    }
  } catch (dbError: any) {
    logger.error({ err: dbError, userId }, 'restorePendingPreview DB error');
  }
  return null;
}

async function persistPendingPreview(userIdBigInt: bigint, pending: PendingPreview): Promise<void> {
  try {
    const events = await prisma.event.findMany({
      where: {
        userId: userIdBigInt,
        type: 'PREVIEW_SESSION',
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 5,
    });

    for (const event of events) {
      try {
        const eventData = JSON.parse(event.payload || '{}');
        if (eventData.messageId === pending.messageId) {
          const updatedPayload = {
            ...eventData,
            padding: pending.padding,
            gridRows: pending.grid.rows,
            gridCols: pending.grid.cols,
            fileUrl: pending.fileUrl,
            fileType: pending.fileType,
            isVideo: pending.isVideo,
            gridOptions: pending.gridOptions,
            updatedAt: new Date().toISOString(),
          };

          await prisma.event.update({
            where: { id: event.id },
            data: {
              payload: JSON.stringify(updatedPayload),
            },
          });
          logger.info({ userId: userIdBigInt, messageId: pending.messageId }, 'Persisted pending preview changes');
          break;
        }
      } catch (parseError) {
        logger.error({ err: parseError, eventId: event.id }, 'Failed to persist preview event payload');
      }
    }
  } catch (dbError: any) {
    logger.error({ err: dbError, userId: userIdBigInt }, 'persistPendingPreview DB error');
  }
}

async function updatePreviewMessage(
  ctx: any,
  env: ReturnType<typeof getEnv>,
  userId: number,
  pending: PendingPreview
) {
  const stopChatAction = startChatAction(
    ctx,
    pending.isVideo ? 'upload_video' : 'upload_photo'
  );

  try {
    const previewResponse = await axios.post(
      `${env.APP_BASE_URL}/api/process/preview`,
      {
        userId: pending.userId.toString(),
        fileUrl: pending.fileUrl,
        padding: pending.padding,
        gridRows: pending.grid.rows,
        gridCols: pending.grid.cols,
        skipQuota: true,
        fileType: pending.fileType,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_KEY,
        },
      }
    );

    const { previewDataUrl, suggestedGrid, gridOptions: rawGridOptions } = previewResponse.data;
    if (suggestedGrid?.rows && suggestedGrid?.cols) {
      pending.grid = {
        rows: clamp(Number(suggestedGrid.rows), GRID_MIN, GRID_MAX),
        cols: clamp(Number(suggestedGrid.cols), GRID_MIN, GRID_MAX),
      };
    }

    const gridOptions: GridOption[] = sanitizeGridOptions(rawGridOptions);

    if (gridOptions.length) {
      pending.gridOptions = gridOptions;
    }

    const base64Data = previewDataUrl.split(',')[1];
    const previewBuffer = Buffer.from(base64Data, 'base64');

    const header = pending.isVideo ? '📽️ Превью первого кадра' : '✅ Превью мозаики';
    const tileCount = pending.grid.rows * pending.grid.cols;

    await ctx.editMessageMedia(
      {
        type: 'photo',
        media: { source: previewBuffer },
        caption: `${header}\nСетка: ${pending.grid.rows}×${pending.grid.cols} (${tileCount} тайлов)\nПаддинг: ${pending.padding}px`,
      },
      buildPreviewKeyboard(pending.grid, pending.padding, pending.gridOptions)
    );

    pendingPreviews.set(userId, pending);

    const media = lastMedia.get(userId);
    if (media) {
      lastMedia.set(userId, {
        ...media,
        padding: pending.padding,
        grid: pending.grid,
        fileType: pending.fileType,
        isVideo: pending.isVideo,
        gridOptions: pending.gridOptions,
      });
    }

    await persistPendingPreview(pending.userId, pending);
  } finally {
    stopChatAction();
  }
}

export function initBot() {
  if (initialized) {
    logger.debug('Bot already initialized, skipping...');
    return;
  }
  
  try {
    const env = getEnv();
    logger.info('Initializing bot...');
    botInstance = new Telegraf(env.TG_BOT_TOKEN);
    
    // Commands - регистрируем команды перед обработчиками
    logger.debug('Registering commands...');
    botInstance.command('start', handleStart);
    botInstance.command('help', handleHelp);
    botInstance.command('generate', handleGenerate);
    botInstance.command('tariffs', handleTariffs);
    botInstance.command('history', handleHistory);
    
    // Admin commands
    botInstance.command('admin', handleAdmin);
    botInstance.command('grant', handleGrant);
    
    // Также обрабатываем команды с параметрами (например, /start@botname)
    botInstance.command('start@*', handleStart);
    botInstance.command('help@*', handleHelp);
    botInstance.command('generate@*', handleGenerate);
    botInstance.command('tariffs@*', handleTariffs);
    botInstance.command('history@*', handleHistory);
    botInstance.command('admin@*', handleAdmin);
    botInstance.command('grant@*', handleGrant);
    
    // Callback queries
    botInstance.action(/^pad:(-|\+|\d+)$/, handlePaddingChange);
    botInstance.action(/^grid:set:(\d+)x(\d+)$/, handleGridSelect);
    botInstance.action(/buy:(pro|max):(30d|365d)/, handleBuySubscription);
    botInstance.action('makepack', handleMakePack);
    
    // Text handlers
    botInstance.hears('🎨 Сгенерировать пак', handleGenerate);
    botInstance.hears('💰 Тарифы', handleTariffs);
    botInstance.hears('📜 История', handleHistory);
    botInstance.hears('❓ Помощь', handleHelp);
    
    // Admin menu handlers
    botInstance.hears('👤 Выдать подписку', async (ctx) => {
      await ctx.reply(
        `📝 *Выдача подписки*\n\n` +
        `Используйте команду:\n` +
        `/grant <user_id> <plan> <days>\n\n` +
        `Пример:\n` +
        `/grant 123456789 PRO 30\n\n` +
        `Планы: PRO, MAX\n` +
        `Days: количество дней (например, 30)`,
        { ...adminMenu, parse_mode: 'Markdown' }
      );
    });
    botInstance.hears('📊 Статистика', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      
      try {
        const username = ctx.from?.username;
        const admin = await isAdmin(BigInt(userId), username);
        if (!admin) {
          await ctx.reply('❌ У вас нет доступа.', mainMenu);
          return;
        }
        
        // Получаем статистику
        const totalUsers = await prisma.user.count();
        const freeUsers = await prisma.user.count({ where: { status: 'FREE' } });
        const proUsers = await prisma.user.count({ where: { status: 'PRO' } });
        const maxUsers = await prisma.user.count({ where: { status: 'MAX' } });
        const adminUsers = await prisma.user.count({ where: { status: 'ADMIN' } });
        const totalPacks = await prisma.pack.count();
        
        await ctx.reply(
          `📊 *Статистика бота*\n\n` +
          `👥 Пользователи:\n` +
          `• Всего: ${totalUsers}\n` +
          `• Free: ${freeUsers}\n` +
          `• Pro: ${proUsers}\n` +
          `• Max: ${maxUsers}\n` +
          `• Admin: ${adminUsers}\n\n` +
          `📦 Паков создано: ${totalPacks}`,
          { ...adminMenu, parse_mode: 'Markdown' }
        );
      } catch (error: any) {
        logger.error({ err: error, userId }, 'Stats error');
        await ctx.reply('❌ Ошибка при получении статистики.', adminMenu);
      }
    });
    botInstance.hears('🔙 Главное меню', handleStart);
    
    // Media handlers
    botInstance.on('photo', handlePhoto);
    botInstance.on('video', handleVideo);
    botInstance.on('animation', handleAnimation);
    // Обработка документов (может быть видео/GIF)
    botInstance.on('document', handleDocument);
    
    // Обработка всех текстовых сообщений (fallback для команд, которые не были обработаны)
    botInstance.on('text', async (ctx) => {
      const text = ctx.message?.text;
      if (!text) return;
      
      logger.debug({ text, userId: ctx.from?.id }, 'Received text message (fallback handler)');
      
      // Если это команда /start, обрабатываем её вручную
      if (text === '/start' || text.startsWith('/start ')) {
        logger.info({ userId: ctx.from?.id }, 'Handling /start command via text handler');
        await handleStart(ctx);
        return;
      }
      
      // Для других необработанных команд просто логируем
      if (text.startsWith('/')) {
        logger.warn({ text, userId: ctx.from?.id }, 'Unhandled command received');
      }
    });
    
    botInstance.catch((err: any, ctx) => {
      logger.error({ 
        err, 
        userId: ctx.from?.id, 
        updateType: ctx.updateType,
        message: err?.message,
        stack: err?.stack,
      }, 'Bot error');
      ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
    });
    
    initialized = true;
    logger.info('Bot initialized successfully');
  } catch (error: any) {
    logger.error({ err: error, stack: error.stack }, 'Failed to initialize bot');
    throw error;
  }
}

export async function handleUpdate(update: any): Promise<void> {
  try {
    if (!botInstance) {
      logger.warn('Bot instance is null, initializing...');
      initBot();
    }
    if (!botInstance) {
      throw new Error('Bot not initialized');
    }
    
    // Логируем тип обновления перед обработкой
    const updateType = update.message ? 'message' : 
                      update.callback_query ? 'callback_query' : 
                      update.edited_message ? 'edited_message' : 'unknown';
    
    logger.debug({ 
      updateId: update.update_id,
      updateType,
      messageText: update.message?.text,
      hasCommand: update.message?.entities?.some((e: any) => e.type === 'bot_command'),
    }, 'Handling update');
    
    await botInstance.handleUpdate(update);
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      update: JSON.stringify(update).substring(0, 500),
    }, 'Error handling update');
    throw error;
  }
}

async function handleStart(ctx: any) {
  try {
    logger.info({ 
      userId: ctx.from?.id, 
      username: ctx.from?.username,
      chatId: ctx.chat?.id,
      messageId: ctx.message?.message_id,
      updateType: ctx.updateType,
    }, 'handleStart called');
    
    const userId = ctx.from?.id;
    if (!userId) {
      logger.warn('handleStart: no userId');
      return;
    }

    await upsertUserProfile(BigInt(userId), ctx.from?.username);

    logger.info({ userId, username: ctx.from?.username }, 'User started bot');
    
    // Проверяем, является ли пользователь админом
    const username = ctx.from?.username;
    const admin = await isAdmin(BigInt(userId), username);
    
    if (admin) {
      // Убеждаемся, что пользователь имеет статус ADMIN в БД
      await setAdmin(BigInt(userId), username);
    }
    
    const adminText = admin ? '\n\n🔐 Вы администратор. Используйте /admin для доступа к админ-панели.' : '';
    
    const welcomeMessage = 
      '👋 Добро пожаловать в "Распил Пак"!\n\n' +
      'Я помогу создать эмодзи-пак из ваших изображений.\n\n' +
      '📋 Доступные команды:\n' +
      '/start - Начать работу с ботом\n' +
      '/generate - Сгенерировать пак из изображения\n' +
      '/history - Просмотреть историю паков\n' +
      '/tariffs - Информация о тарифах\n' +
      '/help - Справка' + adminText + '\n\n' +
      'Или используйте меню ниже ⬇️';
    
    await ctx.reply(welcomeMessage, mainMenu);
    logger.info({ userId }, 'Start message sent successfully');
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      message: error.message,
      userId: ctx.from?.id,
    }, 'Error in handleStart');
    try {
      await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu);
    } catch (replyError: any) {
      logger.error({ err: replyError }, 'Failed to send error message');
    }
  }
}

async function handleGenerate(ctx: any) {
  try {
    await ctx.reply('📸 Отправьте мне изображение (PNG, JPG, WEBP, до 10 МБ).\n\nИли используйте кнопку "🎨 Сгенерировать пак" в меню.', Markup.removeKeyboard());
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleGenerate');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleTariffs(ctx: any) {
  try {
    const message =
      '💎 <b>Подписки:</b>\n' +
      'Free — 5 обработок/мес, брендинг, до 9–15 эмодзи.\n' +
      'Pro — 299₽/мес или 1990₽/год: без бренда, до 15×15, без рекламы.\n' +
      'Max — 399₽/мес или 2490₽/год: всё безлимитно.\n\n' +
      'Выбери подписку:';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💎 Pro — 30 дней', 'buy:pro:30d'),
        Markup.button.callback('Pro — 365 дней', 'buy:pro:365d'),
      ],
      [
        Markup.button.callback('🔥 Max — 30 дней', 'buy:max:30d'),
        Markup.button.callback('Max — 365 дней', 'buy:max:365d'),
      ],
    ]);

    await ctx.reply(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleTariffs');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleBuySubscription(ctx: any) {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpMatchArray | undefined;
    const plan = match?.[1];
    const term = match?.[2];

    if (!plan || !term) {
      await ctx.reply('❌ Не удалось определить параметры подписки. Попробуй ещё раз.');
      return;
    }

    const env = getEnv();

    const response = await axios.post(
      `${env.APP_BASE_URL}/api/billing/create-link`,
      {
        userId: ctx.from.id,
        plan,
        term,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_KEY,
        },
        timeout: 15000,
      }
    );

    const paymentUrl: string | undefined = response.data?.paymentUrl;

    if (paymentUrl) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('💳 Оплатить подписку', paymentUrl)],
      ]);
      await ctx.reply('Перейди по ссылке, чтобы завершить оплату.', keyboard);
    } else {
      logger.warn({ plan, term, response: response.data }, 'T-Bank link missing');
      await ctx.reply('🚧 Не удалось получить ссылку на оплату. Попробуй ещё раз позже.');
    }
  } catch (error: any) {
    logger.error({ err: error }, 'Error creating T-Bank payment link');
    await ctx.reply('❌ Ошибка при создании ссылки. Попробуй ещё раз позже.');
  }
}

async function handleHistory(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handleHistory: no userId');
    return;
  }

  const env = getEnv();
  try {
    await ctx.reply('⏳ Загружаю твою историю...').catch(() => {});

    const response = await axios.get(`${env.APP_BASE_URL}/api/history/list`, {
      params: { userId: userId.toString() },
    });

    const items: any[] = response.data?.items ?? [];

    if (!items.length) {
      await ctx.reply('История пуста 😶');
      return;
    }

    for (const pack of items) {
      const date = pack.createdAt ? new Date(pack.createdAt) : null;
      let text = `🧩 <b>${pack.kind === 'ANIMATED' ? 'Видео' : 'Картинка'}</b>\n`;
      text += `📅 ${date ? date.toLocaleString('ru-RU') : 'Неизвестно'}\n`;
      text += `📦 Сетка: ${pack.gridRows}×${pack.gridCols}, паддинг ${pack.padding}px\n`;
      text += `⚙️ Статус: <b>${pack.status}</b>`;
      if (pack.status === 'READY' && pack.setLink) {
        text += `\n🔗 <a href="${pack.setLink}">Открыть пак</a>`;
      }

      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: false });
    }
  } catch (error: any) {
    logger.error({ err: error, userId }, 'History fetch error');
    await ctx.reply('❌ Не удалось загрузить историю. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleHelp(ctx: any) {
  try {
    const helpMessage = 
      '📖 Справка по использованию бота "Распил Пак"\n\n' +
      '🔹 Команды:\n' +
      '/start - Начать работу с ботом\n' +
      '/generate - Сгенерировать пак из изображения\n' +
      '/history - Просмотреть историю созданных паков\n' +
      '/tariffs - Информация о тарифах и лимитах\n' +
      '/help - Показать эту справку\n\n' +
      '🔹 Как использовать:\n' +
      '1. Нажмите "🎨 Сгенерировать пак" или отправьте команду /generate\n' +
      '2. Отправьте изображение (PNG, JPG, WEBP, до 10 МБ)\n' +
      '3. Получите превью мозаики с автоматической разметкой\n' +
      '4. Настройте отступы (паддинг) с помощью кнопок "Паддинг -/+"\n' +
      '5. Нажмите "Дальше" для сохранения\n\n' +
      '🔹 Лимиты:\n' +
      '• Бесплатный тариф: 5 обработок в месяц\n' +
      '• Pro тариф: 50 обработок в месяц (планируется)\n' +
      '• Max тариф: 200 обработок в месяц (планируется)\n\n' +
      'В будущем появится возможность создавать видео/GIF паки и оплачивать расширенные лимиты.';
    
    await ctx.reply(helpMessage, mainMenu);
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleHelp');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handlePhoto(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message || !('photo' in ctx.message)) return;

  const env = getEnv();
  const photo = ctx.message.photo;
  const largestPhoto = photo[photo.length - 1];

  if (largestPhoto.file_size && largestPhoto.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  const fileId = largestPhoto.file_id;
  await ctx.reply('📸 Обрабатываю изображение...', Markup.removeKeyboard());

  try {
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;

    const username = ctx.from?.username;
    const success = await generatePreviewAndSend(ctx, {
      userId,
      fileUrl,
      padding: 0,
      fileType: 'image',
      username,
      captionPrefix: '🖼️ Превью мозаики',
    });

    if (!success) {
      return;
    }
  } catch (error: any) {
    if (error.response?.status === 429) {
      await ctx.reply(
        `❌ ${error.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
        mainMenu
      );
      return;
    }
    logger.error({ err: error, userId }, 'Photo processing error');
    await ctx.reply(
      '❌ Произошла ошибка при обработке изображения. Попробуйте позже.',
      mainMenu
    );
  }
}

async function handlePaddingChange(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handlePaddingChange: no userId');
    return;
  }

  const env = getEnv();

  logger.info({
    userId,
    pendingKeys: Array.from(pendingPreviews.keys()),
    pendingSize: pendingPreviews.size,
    callbackQuery: ctx.callbackQuery?.data,
    messageId: ctx.callbackQuery?.message?.message_id,
  }, 'handlePaddingChange: checking pending previews');

  let match: RegExpMatchArray | string | null = ctx.match;

  if (typeof match === 'string') {
    const regexMatch = match.match(/^pad:(-|\+|\d+)$/);
    if (regexMatch) {
      match = regexMatch;
    } else {
      logger.warn({ match, userId }, 'Invalid padding match format');
      await ctx.answerCbQuery('Ошибка: неверный формат команды').catch(() => {});
      return;
    }
  }

  const actionValue = Array.isArray(match) ? match[1] : null;

  if (!actionValue) {
    logger.warn({ match, userId }, 'No padding value in match');
    await ctx.answerCbQuery('Ошибка: не найден паддинг').catch(() => {});
    return;
  }

  const userIdBigInt = BigInt(userId);
  const messageId = ctx.callbackQuery?.message?.message_id;

  let pending = pendingPreviews.get(userId);

  if (!pending && messageId) {
    const restored = await restorePendingPreview(userId, userIdBigInt, messageId);
    if (restored) {
      pending = restored;
    }
  }

  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.').catch(() => {});
    return;
  }

  let newPadding: number;
  if (actionValue === '-' || actionValue === '+') {
    const delta = actionValue === '-' ? -2 : 2;
    newPadding = clamp(pending.padding + delta, PADDING_MIN, PADDING_MAX);
    if (newPadding === pending.padding) {
      await ctx.answerCbQuery(actionValue === '-' ? 'Минимальный паддинг' : 'Максимальный паддинг').catch(() => {});
      return;
    }
  } else {
    const parsedPadding = parseInt(actionValue, 10);
    if (Number.isNaN(parsedPadding)) {
      logger.warn({ actionValue, userId }, 'Invalid padding value');
      await ctx.answerCbQuery('Ошибка: неверное значение паддинга').catch(() => {});
      return;
    }
    newPadding = parsedPadding;
  }

  await ctx.answerCbQuery('Обновляю превью...').catch(() => {});

  try {
    logger.info({ userId, newPadding }, 'Updating padding');

    pending = {
      ...pending,
      padding: newPadding,
    };

    await updatePreviewMessage(ctx, env, userId, pending);
    await ctx.answerCbQuery('Готово!').catch(() => {});
  } catch (error: any) {
    logger.error({
      err: error,
      stack: error.stack,
      userId,
      newPadding,
      responseStatus: error.response?.status,
      responseData: error.response?.data,
    }, 'Padding change error');

    pendingPreviews.set(userId, pending);

    const errorMessage = error.response?.data?.error || error.message || 'Неизвестная ошибка';
    await ctx.answerCbQuery(`Ошибка: ${errorMessage}`).catch(() => {});

    try {
      await ctx.reply(`❌ Ошибка при обновлении превью: ${errorMessage}`, mainMenu).catch(() => {});
    } catch {}
  }
}

async function handleGridSelect(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handleGridSelect: no userId');
    return;
  }

  let match: RegExpMatchArray | string | null = ctx.match;
  if (typeof match === 'string') {
    const regexMatch = match.match(/^grid:set:(\d+)x(\d+)$/);
    if (regexMatch) {
      match = regexMatch;
    }
  }

  if (!Array.isArray(match)) {
    await ctx.answerCbQuery('Ошибка: неверный выбор сетки').catch(() => {});
    return;
  }

  const targetRows = clamp(parseInt(match[1], 10), GRID_MIN, GRID_MAX);
  const targetCols = clamp(parseInt(match[2], 10), GRID_MIN, GRID_MAX);

  if (!targetRows || !targetCols) {
    await ctx.answerCbQuery('Ошибка: неверный размер сетки').catch(() => {});
    return;
  }

  const env = getEnv();
  const userIdBigInt = BigInt(userId);
  const messageId = ctx.callbackQuery?.message?.message_id;

  let pending = pendingPreviews.get(userId);
  if (!pending && messageId) {
    const restored = await restorePendingPreview(userId, userIdBigInt, messageId);
    if (restored) {
      pending = restored;
    }
  }

  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте файл заново.').catch(() => {});
    return;
  }

  if (pending.grid.rows === targetRows && pending.grid.cols === targetCols) {
    await ctx.answerCbQuery('Эта сетка уже выбрана').catch(() => {});
    return;
  }

  pending = {
    ...pending,
    grid: { rows: targetRows, cols: targetCols },
  };

  await ctx.answerCbQuery('Обновляю сетку...').catch(() => {});

  try {
    await updatePreviewMessage(ctx, env, userId, pending);
    await ctx.answerCbQuery('Готово!').catch(() => {});
  } catch (error: any) {
    logger.error({
      err: error,
      stack: error.stack,
      userId,
      targetRows,
      targetCols,
    }, 'Grid select error');

    pendingPreviews.set(userId, pending);

    const errorMessage = error.response?.data?.error || error.message || 'Неизвестная ошибка';
    await ctx.answerCbQuery(`Ошибка: ${errorMessage}`).catch(() => {});
    try {
      await ctx.reply(`❌ Ошибка при обновлении сетки: ${errorMessage}`, mainMenu).catch(() => {});
    } catch {
      // ignore
    }
  }
}

async function handleMakePack(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    return;
  }

  await ctx.answerCbQuery().catch(() => {});

  let media = lastMedia.get(userId);

  if (!media) {
    try {
      const events = await prisma.event.findMany({
        where: {
          userId: BigInt(userId),
          type: 'PREVIEW_SESSION',
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
      });

      const lastEvent = events[0];
      if (lastEvent) {
        const data = JSON.parse(lastEvent.payload || '{}');
        if (data?.fileUrl) {
          media = {
            fileUrl: data.fileUrl,
            fileType: data.fileType ?? 'image',
            isVideo: Boolean(data.isVideo),
            padding: data.padding ?? 2,
            grid: data.gridRows && data.gridCols ? { rows: data.gridRows, cols: data.gridCols } : undefined,
            gridOptions: sanitizeGridOptions(data.gridOptions),
          };
          lastMedia.set(userId, media);
        }
      }
    } catch (error: any) {
      logger.error({ err: error, userId }, 'Failed to restore last media from DB');
    }
  }

  if (!media) {
    await ctx.reply('Ошибка: не найден файл для сборки пака.', mainMenu).catch(() => {});
    return;
  }

  const grid = media.grid ?? { rows: 3, cols: 3 };

  const isImage = media.fileType === 'image';
 
  const env = getEnv();

  await ctx.reply('⏳ Задача поставлена в очередь. Как только пак будет готов — пришлю ссылку!').catch(() => {});

  const stopChatAction = startChatAction(ctx, isImage ? 'upload_photo' : 'upload_video');

  try {
    const response = await axios.post(
      `${env.APP_BASE_URL}/api/packs/create`,
      {
        fileUrl: media.fileUrl,
        userId,
        removeBranding: false,
        gridRows: grid.rows,
        gridCols: grid.cols,
        padding: media.padding ?? 2,
        mediaType: isImage ? 'image' : 'video',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_KEY,
        },
        timeout: 120000,
      }
    );

    if (response.data?.error) {
      await ctx.reply(`⚠️ ${response.data.error}`).catch(() => {});
      return;
    }
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Make pack error');
    const message = error.response?.data?.error || error.message || 'Неизвестная ошибка';
    await ctx.reply(`❌ Ошибка постановки задачи в очередь: ${message}`, mainMenu).catch(() => {});
  } finally {
    stopChatAction();
  }
}

async function handleNext(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const env = getEnv();
  const userIdBigInt = BigInt(userId);
  const messageId = ctx.callbackQuery?.message?.message_id;
  
  // Сначала пробуем получить из памяти
  let pending = pendingPreviews.get(userId);
  
  // Если не нашли в памяти, ищем в базе данных
  if (!pending) {
    try {
      const events = await prisma.event.findMany({
        where: {
          userId: userIdBigInt,
          type: 'PREVIEW_SESSION',
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 1,
      });
      
      if (events.length > 0) {
        try {
          const eventData = JSON.parse(events[0].payload);
          pending = {
            messageId: eventData.messageId || messageId || 0,
            padding: eventData.padding || 2,
            grid: {
              rows: clamp(Number(eventData.gridRows) || 3, GRID_MIN, GRID_MAX),
              cols: clamp(Number(eventData.gridCols) || 3, GRID_MIN, GRID_MAX),
            },
            fileUrl: eventData.fileUrl,
            userId: userIdBigInt,
            isVideo: Boolean(eventData.isVideo),
            fileType: (eventData.fileType ?? (eventData.isVideo ? 'video' : 'image')) as 'image' | 'video' | 'animation',
          };
          pendingPreviews.set(userId, pending);
          logger.info({ userId, messageId: eventData.messageId }, 'Found pending in DB for handleNext');
        } catch (parseError: any) {
          logger.error({ err: parseError, userId }, 'Failed to parse event payload in handleNext');
        }
      }
    } catch (dbError: any) {
      logger.error({ err: dbError, userId }, 'Error searching pending in DB for handleNext');
    }
  }

  if (!pending) {
    await ctx.answerCbQuery('Превью не найдено. Отправьте новое изображение.').catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Сохранение...');

  try {
    await axios.post(
      `${env.APP_BASE_URL}/api/packs/create`,
      {
        userId: pending.userId.toString(), // Convert to string for JSON serialization
        kind: 'STATIC',
        gridRows: pending.grid.rows,
        gridCols: pending.grid.cols,
        padding: pending.padding,
        tilesCount: pending.grid.rows * pending.grid.cols,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_KEY,
        },
      }
    );

    await ctx.editMessageCaption(
      '✅ Превью готово!\n\nОк, превью сохранено. Сборка реального эмодзи-пака будет доступна в следующем обновлении.',
      Markup.inlineKeyboard([])
    );

    // Удаляем из памяти
    pendingPreviews.delete(userId);
    
    // Удаляем из базы данных (опционально, можно оставить для истории)
    try {
      const events = await prisma.event.findMany({
        where: {
          userId: userIdBigInt,
          type: 'PREVIEW_SESSION',
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 10,
      });
      
      // Удаляем событие с нужным messageId
      for (const event of events) {
        try {
          const eventData = JSON.parse(event.payload);
          if (eventData.messageId === pending.messageId) {
            await prisma.event.delete({
              where: { id: event.id },
            });
            logger.info({ userId, messageId: pending.messageId }, 'Deleted pending from DB');
            break;
          }
        } catch (parseError) {
          continue;
        }
      }
    } catch (dbError: any) {
      logger.error({ err: dbError, userId }, 'Failed to delete pending from DB');
    }
    
    await ctx.reply('Используйте меню для новых операций.', mainMenu);
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Pack save error');
    await ctx.answerCbQuery('Ошибка при сохранении');
  }
}

// Admin menu
const adminMenu = Markup.keyboard([
  ['👤 Выдать подписку'],
  ['📊 Статистика'],
  ['🔙 Главное меню'],
]).resize();

/**
 * Admin command handler
 */
async function upsertUserProfile(userId: bigint, username?: string) {
  const normalizedUsername = normalizeUsername(username);
  try {
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        status: 'FREE',
        ...(normalizedUsername ? { username: normalizedUsername } : {}),
      },
      update: normalizedUsername ? { username: normalizedUsername } : {},
    });
  } catch (error: any) {
    logger.error({ err: error, userId, username: normalizedUsername }, 'Failed to upsert user profile');
  }
}

async function handleAdmin(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const username = ctx.from?.username;
    const admin = await isAdmin(BigInt(userId), username);

    if (!admin) {
      await ctx.reply('❌ У вас нет доступа к админ-панели.', mainMenu);
      return;
    }

    // Убеждаемся, что пользователь имеет статус ADMIN в БД
    await setAdmin(BigInt(userId), username);

    const message = `🔐 Админ-панель\n\n` +
      `Доступные команды:\n` +
      `• /grant <user_id|@username> <plan> [days] - Выдать подписку\n` +
      `  Пример: /grant @username PRO\n` +
      `  Планы: PRO, MAX\n\n` +
      `• /admin - Открыть админ-меню\n\n` +
      `По умолчанию подписка выдаётся на 30 дней.\n\n` +
      `Ваш статус: Админ (неограниченные обработки)`;

    await ctx.reply(message, adminMenu);
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Admin command error');
    await ctx.reply('❌ Ошибка при открытии админ-панели.', mainMenu);
  }
}

/**
 * Grant subscription command handler
 * Usage: /grant <user_id|@username> <plan> [days]
 * Example: /grant @username PRO
 */
async function handleGrant(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const username = ctx.from?.username;
    const admin = await isAdmin(BigInt(userId), username);

    if (!admin) {
      await ctx.reply('❌ У вас нет доступа к этой команде.', mainMenu);
      return;
    }

    const commandArgs = ctx.message?.text?.trim().split(/\s+/) || [];

    if (commandArgs.length < 3) {
      await ctx.reply(
        `❌ Неверный формат команды.\n\n` +
        `Использование: /grant <user_id|@username> <plan> [days]\n` +
        `Пример: /grant @username PRO\n\n` +
        `Планы: PRO, MAX\n` +
        `Если срок не указан, используется 30 дней`
      , adminMenu
      );
      return;
    }

    const rawTarget = commandArgs[1];
    const plan = commandArgs[2].toUpperCase() as 'PRO' | 'MAX';
    const daysArg = commandArgs[3];
    const parsedDays = daysArg ? parseInt(daysArg, 10) : 30;
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : NaN;

    if (plan !== 'PRO' && plan !== 'MAX') {
      await ctx.reply('❌ Неверный план. Используйте PRO или MAX.', adminMenu);
      return;
    }

    if (Number.isNaN(days)) {
      await ctx.reply('❌ Неверное количество дней. Используйте положительное число.', adminMenu);
      return;
    }

    let targetUserId: bigint | null = null;
    let targetUsernameNormalized: string | undefined;

    if (/^\d+$/.test(rawTarget)) {
      targetUserId = BigInt(rawTarget);
      const existingUser = await prisma.user.findUnique({ where: { id: targetUserId } });
      if (existingUser?.username) {
        targetUsernameNormalized = existingUser.username;
      }
    } else {
      targetUsernameNormalized = normalizeUsername(rawTarget);
      if (!targetUsernameNormalized) {
        await ctx.reply('❌ Укажите корректный никнейм (например, @username).', adminMenu);
        return;
      }

      const targetUser = await prisma.user.findFirst({
        where: { username: targetUsernameNormalized },
      });

      if (!targetUser) {
        await ctx.reply(`❌ Пользователь с ником @${targetUsernameNormalized} не найден. Убедитесь, что он уже запускал бота.`, adminMenu);
        return;
      }

      targetUserId = targetUser.id;
    }

    if (!targetUserId) {
      await ctx.reply('❌ Не удалось определить пользователя для выдачи подписки.', adminMenu);
      return;
    }

    await grantSubscription(targetUserId, plan, days, targetUsernameNormalized);

    const paidUntil = new Date();
    paidUntil.setDate(paidUntil.getDate() + days);

    const targetLabel = targetUsernameNormalized ? `@${targetUsernameNormalized}` : targetUserId.toString();

    await ctx.reply(
      `✅ Подписка выдана!\n\n` +
      `Пользователь: ${targetLabel}\n` +
      `План: ${plan}\n` +
      `Дней: ${days}\n` +
      `Действует до: ${paidUntil.toLocaleDateString('ru-RU')}`,
      adminMenu
    );

    logger.info({ adminId: userId, targetUserId, plan, days }, 'Subscription granted by admin');
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Grant subscription error');
    await ctx.reply(`❌ Ошибка при выдаче подписки: ${error.message || 'Неизвестная ошибка'}`, adminMenu);
  }
}

async function handleVideo(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message || !('video' in ctx.message)) return;

  const env = getEnv();
  const video = ctx.message.video;

  // Проверка размера файла
  if (video.file_size && video.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  const fileId = video.file_id;
  await ctx.reply('🔄 Обрабатываю видео...', Markup.removeKeyboard());

  try {
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;

    const username = ctx.from?.username;
    const success = await generatePreviewAndSend(ctx, {
      userId,
      fileUrl,
      padding: 0,
      fileType: 'video',
      username,
      captionPrefix: '📽️ Превью первого кадра видео',
    });

    if (!success) {
      return;
    }
  } catch (error: any) {
    if (error.response?.status === 429) {
      await ctx.reply(
        `❌ ${error.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
        mainMenu
      );
      return;
    }
    logger.error({ err: error, userId }, 'Video processing error');
    await ctx.reply(
      '❌ Произошла ошибка при обработке видео. Попробуйте позже.',
      mainMenu
    );
  }
}

async function handleDocument(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message || !('document' in ctx.message)) return;

  const env = getEnv();
  const document = ctx.message.document;

  // Проверяем, что это видео или GIF
  const mimeType = document.mime_type || '';
  const fileName = document.file_name || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  const isVideoFile = mimeType.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext);
  const isGif = mimeType === 'image/gif' || ext === 'gif';

  if (!isVideoFile && !isGif) {
    await ctx.reply('❌ Поддерживаются только видео и GIF файлы. Используйте изображения для создания паков.', mainMenu);
    return;
  }

  // Проверка размера файла
  if (document.file_size && document.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  const fileId = document.file_id;
  await ctx.reply('🔄 Обрабатываю файл...', Markup.removeKeyboard());

  try {
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;

    const username = ctx.from?.username;
    const success = await generatePreviewAndSend(ctx, {
      userId,
      fileUrl,
      padding: 0,
      fileType: isVideoFile ? 'video' : isGif ? 'animation' : 'image',
      username,
      captionPrefix: isVideoFile || isGif ? '📽️ Превью первого кадра' : '🖼️ Превью мозаики',
    });

    if (!success) {
      return;
    }
  } catch (error: any) {
    if (error.response?.status === 429) {
      await ctx.reply(
        `❌ ${error.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
        mainMenu
      );
      return;
    }
    logger.error({ err: error, userId }, 'Document processing error');
    await ctx.reply(
      '❌ Произошла ошибка при обработке файла. Попробуйте позже.',
      mainMenu
    );
  }
}

async function handleAnimation(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId || !ctx.message || !('animation' in ctx.message)) return;

  const env = getEnv();
  const animation = ctx.message.animation;

  // Проверка размера файла
  if (animation.file_size && animation.file_size > 10 * 1024 * 1024) {
    await ctx.reply('❌ Файл слишком большой. Максимальный размер: 10 МБ.', mainMenu);
    return;
  }

  const fileId = animation.file_id;
  await ctx.reply('🔄 Обрабатываю GIF...', Markup.removeKeyboard());

  try {
    const fileInfoResponse = await axios.get(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfoResponse.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;

    const username = ctx.from?.username;
    const success = await generatePreviewAndSend(ctx, {
      userId,
      fileUrl,
      padding: 0,
      fileType: 'animation',
      username,
      captionPrefix: '📽️ Превью первого кадра GIF',
    });

    if (!success) {
      return;
    }
  } catch (error: any) {
    if (error.response?.status === 429) {
      await ctx.reply(
        `❌ ${error.response.data.error || 'Лимит обработок достигнут'}\n\nИспользуйте "💰 Тарифы" для увеличения лимита.`,
        mainMenu
      );
      return;
    }
    logger.error({ err: error, userId }, 'Animation processing error');
    await ctx.reply(
      '❌ Произошла ошибка при обработке GIF. Попробуйте позже.',
      mainMenu
    );
  }
}

