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

    const keyboard = buildPreviewKeyboard(suggestedGrid, padding, gridOptions, false);

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
            isCustomGrid: false, // При создании превью сетка еще не кастомная
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
  ['🎨 Сгенерировать пак', '💰 Тарифы', '💳 Профиль'],
  ['📜 История', '🎁 Реферальная программа', '❓ Помощь'],
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
  gridOptions: GridOption[] = [],
  isCustomGrid: boolean = false
) {
  logger.info({ 
    grid: `${grid.rows}x${grid.cols}`, 
    isCustomGrid, 
    gridOptionsCount: gridOptions.length 
  }, 'buildPreviewKeyboard called');
  
  const keyboardRows: any[] = [];

  // Если выбрана кастомная сетка, не показываем кнопки с вариантами
  if (!isCustomGrid) {
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

    if (optionButtons.length) {
      for (let i = 0; i < optionButtons.length; i += 3) {
        keyboardRows.push(optionButtons.slice(i, i + 3));
      }
    }
  } else {
    // Для кастомной сетки не показываем кнопки с вариантами - только текущую сетку
    // Но не добавляем кнопку с кастомной сеткой, так как она уже выбрана
    // Просто пропускаем варианты
  }

  keyboardRows.push([Markup.button.callback(`⚙️ Настроить паддинг (${padding}px)`, 'padding:settings')]);
  keyboardRows.push([Markup.button.callback('📐 Выбрать своё соотношение', 'grid:custom')]);
  keyboardRows.push([Markup.button.callback('✨ Создать эмодзи-пак', 'makepack')]);

  logger.info({ 
    grid: `${grid.rows}x${grid.cols}`, 
    isCustomGrid, 
    keyboardRowsCount: keyboardRows.length,
    firstRowButtons: keyboardRows[0]?.length || 0
  }, 'buildPreviewKeyboard returning');

  return Markup.inlineKeyboard(keyboardRows);
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
            isCustomGrid: Boolean(eventData.isCustomGrid), // Восстанавливаем флаг кастомной сетки
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
            isCustomGrid: pending.isCustomGrid ?? false, // Сохраняем флаг кастомной сетки
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
  // ВАЖНО: pending.grid уже содержит правильные значения (обновлены в applyCustomGrid или handleGridSelect)
  // Сохраняем grid ДО вызова API, чтобы не потерять пользовательский выбор
  // Используем значения из pending.grid напрямую, так как они уже обновлены
  const userSelectedGrid = { 
    rows: pending.grid.rows, 
    cols: pending.grid.cols 
  };
  const isCustomGrid = pending.isCustomGrid ?? false;
  
  logger.info({ 
    userId, 
    pendingGridBeforeAPI: `${pending.grid.rows}x${pending.grid.cols}`,
    userSelectedGrid: `${userSelectedGrid.rows}x${userSelectedGrid.cols}`,
    isCustomGrid
  }, 'Starting updatePreviewMessage');
  
  const stopChatAction = startChatAction(
    ctx,
    pending.isVideo ? 'upload_video' : 'upload_photo'
  );

  try {
    logger.info({ 
      userId, 
      gridRows: pending.grid.rows, 
      gridCols: pending.grid.cols,
      padding: pending.padding,
      userSelectedGrid: `${userSelectedGrid.rows}x${userSelectedGrid.cols}`,
      pendingGrid: `${pending.grid.rows}x${pending.grid.cols}`,
      userSelectedGridRows: userSelectedGrid.rows,
      userSelectedGridCols: userSelectedGrid.cols,
      pendingGridRows: pending.grid.rows,
      pendingGridCols: pending.grid.cols
    }, 'Updating preview with custom grid');
    
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
    
    logger.info({ 
      userId, 
      requestedGrid: `${pending.grid.rows}x${pending.grid.cols}`,
      suggestedGrid: suggestedGrid ? `${suggestedGrid.rows}x${suggestedGrid.cols}` : 'none'
    }, 'Preview API response received');
    
    // НЕ перезаписываем pending.grid - она уже установлена пользователем или была передана в запросе
    // suggestedGrid используется только для gridOptions, если они не были переданы
    
    // ВАЖНО: Восстанавливаем пользовательский выбор сетки (на случай если API изменил pending.grid)
    // Но используем userSelectedGrid, который был сохранен ДО вызова API
    pending.grid = { rows: userSelectedGrid.rows, cols: userSelectedGrid.cols };
    
    logger.info({ 
      userId, 
      suggestedGrid: suggestedGrid ? `${suggestedGrid.rows}x${suggestedGrid.cols}` : 'none',
      userSelectedGrid: `${userSelectedGrid.rows}x${userSelectedGrid.cols}`,
      pendingGridAfterAPI: `${pending.grid.rows}x${pending.grid.cols}`,
      isCustomGrid
    }, 'After API call, restoring user selected grid');

    const gridOptions: GridOption[] = sanitizeGridOptions(rawGridOptions);

    // Если сетка кастомная, не добавляем ее в gridOptions
    // Это позволит buildPreviewKeyboard скрыть кнопки с вариантами
    if (!isCustomGrid) {
      const hasCurrentGrid = gridOptions.some(
        (opt) => opt.rows === userSelectedGrid.rows && opt.cols === userSelectedGrid.cols
      );
      if (!hasCurrentGrid) {
        gridOptions.unshift({
          rows: userSelectedGrid.rows,
          cols: userSelectedGrid.cols,
          tilesCount: userSelectedGrid.rows * userSelectedGrid.cols,
        });
      }
    }

    pending.gridOptions = gridOptions;

    const base64Data = previewDataUrl.split(',')[1];
    const previewBuffer = Buffer.from(base64Data, 'base64');

    // Убираем подпись под превью - пользователь видит сетку визуально
    const caption = '';

    logger.info({ 
      userId, 
      pendingGrid: `${pending.grid.rows}x${pending.grid.cols}`,
      userSelectedGrid: `${userSelectedGrid.rows}x${userSelectedGrid.cols}`,
      isCustomGrid,
      pendingIsCustomGrid: pending.isCustomGrid
    }, 'Updating message without caption (grid visualized with lines)');

    try {
      // ВАЖНО: Используем userSelectedGrid для клавиатуры, чтобы кастомная сетка правильно отображалась
      const keyboard = buildPreviewKeyboard(userSelectedGrid, pending.padding, pending.gridOptions, isCustomGrid);
      logger.info({ 
        userId, 
        caption: caption.substring(0, 100),
        isCustomGrid,
        userSelectedGrid: `${userSelectedGrid.rows}x${userSelectedGrid.cols}`,
        captionFull: caption,
        keyboardRowsCount: keyboard.inline_keyboard?.length || 0
      }, 'About to edit message media with caption and keyboard');
      
      // Обновляем медиа без подписи (подпись убрана, сетка визуализируется линиями на превью)
      try {
        await ctx.editMessageMedia(
          {
            type: 'photo',
            media: { source: previewBuffer },
            // caption не передаем - убираем подпись полностью
          },
          keyboard
        );
        logger.info({ userId }, 'Message media updated without caption');
      } catch (mediaError: any) {
        logger.warn({ err: mediaError, userId }, 'Failed to edit message media, trying caption only');
        // Если не удалось отредактировать медиа, пробуем отредактировать только caption (но caption пустой)
        try {
          // ВАЖНО: Используем userSelectedGrid для клавиатуры, чтобы кастомная сетка правильно отображалась
          const keyboard = buildPreviewKeyboard(userSelectedGrid, pending.padding, pending.gridOptions, isCustomGrid);
          // Убираем подпись - передаем пустую строку
          await ctx.editMessageCaption('', keyboard);
        } catch (captionError: any) {
          logger.error({ err: captionError, userId }, 'Failed to edit message caption');
          throw captionError;
        }
      }
    } catch (editError: any) {
      logger.error({ err: editError, userId }, 'Failed to update preview message');
      throw editError;
    }

    // ВАЖНО: Обновляем pending с правильными значениями перед сохранением
    pending.grid = { rows: userSelectedGrid.rows, cols: userSelectedGrid.cols };
    pending.isCustomGrid = isCustomGrid;
    pendingPreviews.set(userId, pending);
    
    // Сохраняем в базу данных
    await persistPendingPreview(pending.userId, pending).catch((err) => {
      logger.error({ err, userId }, 'Failed to persist pending preview');
    });

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

    // persistPendingPreview уже вызван выше
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
    
    // Admin commands
    botInstance.command('admin', handleAdmin);
    botInstance.command('grant', handleGrant);
    
    // Также обрабатываем команды с параметрами (например, /start@botname)
    botInstance.command('start@*', handleStart);
    botInstance.command('help@*', handleHelp);
    botInstance.command('generate@*', handleGenerate);
    botInstance.command('tariffs@*', handleTariffs);
    botInstance.command('admin@*', handleAdmin);
    botInstance.command('grant@*', handleGrant);
    
    // Callback queries
    botInstance.action('padding:settings', handlePaddingSettings);
    botInstance.action('padding:back', handlePaddingBack);
    botInstance.action(/^pad:(-|\+|\d+)$/, handlePaddingChange);
    botInstance.action(/^grid:set:(\d+)x(\d+)$/, handleGridSelect);
    botInstance.action('grid:custom', handleCustomGrid);
    // ВАЖНО: Сначала регистрируем более специфичные обработчики (cols), потом общие
    botInstance.action('grid:custom:back', handleCustomGridSelect);
    botInstance.action('grid:custom:info', handleCustomGridSelect);
    botInstance.action(/^grid:custom:cols:(\d+)$/, handleCustomGridSelect);
    botInstance.action(/^grid:custom:(\d+)x(\d+)$/, handleCustomGridSelect);
    botInstance.action(/buy:pro:(30d|365d)/, handleBuySubscription);
    botInstance.action(/referral:use:(\d+)/, handleUseReferralBonus);
    botInstance.action('makepack', handleMakePack);
    botInstance.action('tariffs:show', handleTariffs);
    botInstance.action('main_menu', handleStart);
    
    // Text handlers
    botInstance.hears('🎨 Сгенерировать пак', handleGenerate);
    botInstance.hears('💰 Тарифы', handleTariffs);
    botInstance.hears('💳 Профиль', handleProfile);
    botInstance.hears('📜 История', handleHistory);
    botInstance.hears('🎁 Реферальная программа', handleReferralProgram);
    botInstance.hears('❓ Помощь', handleHelp);
    
    // Admin menu handlers
    botInstance.hears('👤 Выдать подписку', async (ctx) => {
      await ctx.reply(
        `📝 *Выдача подписки*\n\n` +
        `Используйте команду:\n` +
        `/grant <user_id> <plan> <days>\n\n` +
        `Пример:\n` +
        `/grant 123456789 PRO 30\n\n` +
        `Планы: PRO\n` +
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
          `${maxUsers > 0 ? `• Max (legacy): ${maxUsers}\n` : ''}` +
          `• Admin: ${adminUsers}\n\n` +
          `📦 Паков создано: ${totalPacks}`,
          { ...adminMenu, parse_mode: 'Markdown' }
        );
      } catch (error: any) {
        logger.error({ err: error, userId }, 'Stats error');
        await ctx.reply('❌ Ошибка при получении статистики.', adminMenu);
      }
    });
    botInstance.hears('📈 Аналитика', handleAnalytics);
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
      logger.error('Bot not initialized after initBot call');
      return; // Не пробрасываем ошибку, просто возвращаемся
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
      updateId: update?.update_id,
    }, 'Error handling update');
    // НЕ пробрасываем ошибку наверх - это вызовет 500 в webhook
    // Ошибки уже обработаны в обработчиках команд
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

    // Извлекаем реферальный код из команды /start ref_XXXXX
    let referralCode: string | undefined;
    // В Telegraf реферальный код передается через ctx.startPayload или через текст сообщения
    const startPayload = ctx.startPayload || ctx.message?.text?.split(' ')[1];
    if (startPayload && typeof startPayload === 'string' && startPayload.startsWith('ref_')) {
      referralCode = startPayload;
      logger.info({ userId, referralCode }, 'Referral code detected in start command');
    }

    try {
      await upsertUserProfile(BigInt(userId), ctx.from?.username, referralCode);
    } catch (dbError: any) {
      logger.error({ err: dbError, userId }, 'Failed to upsert user profile, continuing anyway');
      // Продолжаем выполнение даже если не удалось сохранить в БД
    }

    logger.info({ userId, username: ctx.from?.username }, 'User started bot');
    
    // Проверяем, является ли пользователь админом
    let admin = false;
    try {
      const username = ctx.from?.username;
      admin = await isAdmin(BigInt(userId), username);
      
      if (admin) {
        // Убеждаемся, что пользователь имеет статус ADMIN в БД
        await setAdmin(BigInt(userId), username);
      }
    } catch (adminError: any) {
      logger.error({ err: adminError, userId }, 'Error checking admin status, continuing as regular user');
      // Продолжаем как обычный пользователь
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
    
    try {
      await ctx.reply(welcomeMessage, mainMenu);
      logger.info({ userId }, 'Start message sent successfully');
    } catch (replyError: any) {
      // Ошибка отправки сообщения (например, "chat not found") не должна вызывать 500
      logger.error({ 
        err: replyError, 
        userId,
        chatId: ctx.chat?.id,
        message: replyError?.message,
      }, 'Error sending start message (non-critical)');
      // Не пробрасываем ошибку дальше - это не критично
    }
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      message: error.message,
      userId: ctx.from?.id,
    }, 'Error in handleStart');
    // Не пробрасываем ошибку - просто логируем
    try {
      await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
    } catch {
      // Игнорируем ошибку отправки сообщения об ошибке
    }
  }
}

async function handleGenerate(ctx: any) {
  try {
    const keyboard = Markup.keyboard([
      ['🔙 Главное меню'],
    ]).resize();
    
    await ctx.reply('📸 Отправьте мне изображение (PNG, JPG, WEBP, до 10 МБ).\n\nИли используйте кнопку "🎨 Сгенерировать пак" в меню.', keyboard);
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleGenerate');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleTariffs(ctx: any) {
  try {
    // Если это callback query, отвечаем на него
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
    }
    const message =
      '💎 <b>Подписки:</b>\n\n' +
      '🆓 <b>Free</b> — 5 обработок/мес, до 9–15 эмодзи\n\n' +
      '⭐ <b>Pro</b> — 299₽/мес или 1990₽/год:\n' +
      '• Безлимитные генерации\n' +
      '• До 15×15 эмодзи\n' +
      '• Без рекламы\n\n' +
      'Выбери подписку:';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💎 Pro — 30 дней', 'buy:pro:30d'),
        Markup.button.callback('Pro — 365 дней', 'buy:pro:365d'),
      ],
      [Markup.button.callback('🔙 Главное меню', 'main_menu')],
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
    // Регулярное выражение: /buy:pro:(30d|365d)/
    // match[0] - полное совпадение
    // match[1] - term (30d или 365d)
    const term = match?.[1] as '30d' | '365d' | undefined;
    const plan = 'pro'; // Всегда 'pro', так как других тарифов нет

    if (!term || (term !== '30d' && term !== '365d')) {
      logger.warn({ match, term }, 'Invalid subscription term');
      await ctx.reply('❌ Не удалось определить параметры подписки. Попробуй ещё раз.');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ Ошибка: не удалось определить пользователя.');
      return;
    }

    // Проверяем, есть ли у пользователя активная подписка
    const userIdBigInt = BigInt(userId);
    const user = await prisma.user.findUnique({
      where: { id: userIdBigInt },
      select: { status: true, paidUntil: true },
    });

    let hasActiveSubscription = false;
    if (user?.paidUntil) {
      const now = new Date();
      hasActiveSubscription = user.paidUntil >= now;
    }

    const env = getEnv();

    const response = await axios.post(
      `${env.APP_BASE_URL}/api/billing/create-link`,
      {
        userId,
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
    const orderId: string | undefined = response.data?.orderId;

    if (paymentUrl) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('💳 Перейти на оплату в Т-Банке', paymentUrl)],
      ]);

      let message = 'Вы хотите перейти на страницу оплаты?';
      
      if (hasActiveSubscription && user?.paidUntil) {
        const daysLeft = Math.ceil((user.paidUntil.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        message += `\n\n⚠️ У вас уже есть активная подписка до ${user.paidUntil.toLocaleDateString('ru-RU', { 
          day: 'numeric', 
          month: 'long',
          year: 'numeric'
        })} (осталось ${daysLeft} дней).\n\nНовая подписка будет добавлена к текущей.`;
      }

      await ctx.reply(message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...keyboard,
      });
    } else {
      logger.warn({ plan, term, response: response.data }, 'T-Bank link missing');
      await ctx.reply('🚧 Не удалось получить ссылку на оплату. Попробуй ещё раз позже.');
    }
  } catch (error: any) {
    logger.error({ err: error, userId: ctx.from?.id }, 'Error creating T-Bank payment link');
    
    if (error.response?.status === 400 || error.response?.status === 502) {
      const errorMessage = error.response?.data?.error || 'Ошибка при создании ссылки на оплату';
      await ctx.reply(`❌ ${errorMessage}. Попробуй ещё раз позже.`);
    } else {
      await ctx.reply('❌ Ошибка при создании ссылки. Попробуй ещё раз позже.');
    }
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
    await ctx.reply('⏳ Загружаю историю генераций...').catch(() => {});

    const response = await axios.get(`${env.APP_BASE_URL}/api/history/list`, {
      params: { userId: userId.toString() },
      headers: {
        'X-Internal-Key': env.INTERNAL_KEY,
      },
    });

    const items: any[] = response.data?.items ?? [];

    if (!items.length) {
      const keyboard = Markup.keyboard([
        ['🔙 Главное меню'],
      ]).resize();
      await ctx.reply('📜 История генераций пуста.\n\nВы еще не создали ни одного эмодзи-пака.', keyboard);
      return;
    }

    // Показываем последние 10 паков
    const recentPacks = items.slice(0, 10);
    
    for (let i = 0; i < recentPacks.length; i++) {
      const pack = recentPacks[i];
      const date = pack.createdAt ? new Date(pack.createdAt) : null;
      const dateStr = date ? date.toLocaleDateString('ru-RU', { 
        day: 'numeric', 
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }) : 'Неизвестно';
      
      const packType = pack.kind === 'ANIMATED' ? '🎬 Видео/GIF' : '🖼️ Картинка';
      const statusEmoji = pack.status === 'READY' ? '✅' : pack.status === 'PROCESSING' ? '⏳' : '❌';
      
      let text = `${packType} ${statusEmoji}\n\n`;
      text += `📅 ${dateStr}\n`;
      text += `📐 Сетка: ${pack.gridRows}×${pack.gridCols} (${pack.gridRows * pack.gridCols} тайлов)\n`;
      text += `📏 Паддинг: ${pack.padding}px\n`;
      text += `⚙️ Статус: <b>${pack.status === 'READY' ? 'Готов' : pack.status === 'PROCESSING' ? 'Обработка' : pack.status}</b>`;
      
      if (pack.status === 'READY' && pack.setLink) {
        text += `\n\n🔗 <a href="${pack.setLink}">Открыть эмодзи-пак</a>`;
      }

      const keyboard = i === recentPacks.length - 1 
        ? Markup.keyboard([['🔙 Главное меню']]).resize()
        : undefined;

      await ctx.reply(text, { 
        parse_mode: 'HTML', 
        disable_web_page_preview: true,
        ...(keyboard || {})
      });
    }

    if (items.length > 10) {
      const keyboard = Markup.keyboard([
        ['🔙 Главное меню'],
      ]).resize();
      await ctx.reply(`\n... и ещё ${items.length - 10} паков в истории.`, keyboard);
    }
  } catch (error: any) {
    logger.error({ err: error, userId }, 'History fetch error');
    await ctx.reply('❌ Не удалось загрузить историю. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleProfile(ctx: any) {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      logger.warn('handleProfile: no userId');
      return;
    }

    const userIdBigInt = BigInt(userId);
    
    // Получаем данные пользователя
    const user = await prisma.user.findUnique({
      where: { id: userIdBigInt },
    });

    // Получаем квоту
    const { getUserQuota, currentPeriod } = await import('@/lib/quota');
    const quota = await getUserQuota(userIdBigInt);

    // Получаем количество паков и историю
    const packs = await prisma.pack.findMany({
      where: { userId: userIdBigInt },
      select: {
        kind: true,
      },
    });

    const imagePacks = packs.filter(p => p.kind === 'STATIC' || !p.kind).length;
    const videoPacks = packs.filter(p => p.kind === 'ANIMATED').length;
    const totalPacks = packs.length;

    // Определяем тариф
    const statusMap: Record<string, string> = {
      'FREE': '🆓 Бесплатный',
      'PRO': '⭐ PRO',
      'MAX': '💎 MAX',
      'ADMIN': '🔐 Администратор',
    };
    const tariffName = statusMap[quota.status] || '🆓 Бесплатный';

    // Определяем оставшиеся обработки
    const remaining = quota.limit === 999999 ? '∞ (безлимит)' : Math.max(0, quota.limit - quota.imagesUsed);

    // Формируем сообщение профиля
    let message = '💳 Личный кабинет\n\n';
    message += `📊 Тариф: ${tariffName}\n\n`;
    
    if (quota.status === 'FREE') {
      // Получаем дату обновления квоты (начало следующего месяца)
      const period = currentPeriod();
      const year = Number(period.substring(0, 4));
      const month = Number(period.substring(4, 6));
      const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1);
      const quotaResetDate = nextMonth.toLocaleDateString('ru-RU', { 
        day: 'numeric', 
        month: 'long',
        year: 'numeric'
      });
      
      message += `🎨 Осталось обработок: ${remaining}\n\n`;
      message += `🔄 Обновятся: ${quotaResetDate}\n\n`;
    } else {
      // Для платных тарифов показываем срок действия подписки
      if (user?.paidUntil) {
        const paidUntilDate = new Date(user.paidUntil);
        const now = new Date();
        if (paidUntilDate >= now) {
          const daysLeft = Math.ceil((paidUntilDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          message += `🎨 Генерации: ∞ (безлимит)\n\n`;
          message += `⏰ Подписка действует до: ${paidUntilDate.toLocaleDateString('ru-RU', { 
            day: 'numeric', 
            month: 'long',
            year: 'numeric'
          })}\n`;
          message += `📅 Осталось дней: ${daysLeft}\n\n`;
        } else {
          message += `🎨 Генерации: ∞ (безлимит)\n\n`;
          message += `⚠️ Подписка истекла\n\n`;
        }
      } else {
        message += `🎨 Генерации: ∞ (безлимит)\n\n`;
      }
    }
    
    message += `📦 Создано паков: ${totalPacks}\n`;
    message += `  Картинок: ${imagePacks}\n`;
    message += `  Видео: ${videoPacks}`;

    const keyboard = Markup.keyboard([
      ['🔙 Главное меню'],
    ]).resize();

    await ctx.reply(message, keyboard);
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleProfile');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

async function handleHelp(ctx: any) {
  try {
    const helpMessage = 
      '📖 Справка по использованию бота "Распил Пак"\n\n' +
      '🎨 <b>Как пользоваться ботом:</b>\n\n' +
      '1. Отправьте боту картинку, видео или гифку\n' +
      '2. Он проанализирует пропорции и предложит варианты сетки\n' +
      '3. Выберите размер кнопкой или создайте свой (до 15×15)\n' +
      '4. Настройте паддинг (отступы между эмодзи) кнопками "Паддинг -/+"\n' +
      '5. Нажмите "Дальше" для создания пака\n' +
      '6. Бот создаст эмодзи-пак из кусочков вашей картинки\n' +
      '7. Сохраните эмодзи-пак, чтобы не потерять\n' +
      '8. Вставляйте картинки в любые посты\n\n' +
      '⚠️ <b>Важно:</b> Чтобы использовать эти эмодзи, вам нужен Telegram Premium.\n\n' +
      '📌 Помните, что в пост можно вставлять не больше 100 кастомных эмодзи. Поэтому добавить много картинок в один пост не получится.\n\n' +
      '📱 <b>Отображение на разных устройствах</b>\n\n' +
      'На разных устройствах и клиентах Telegram отображает эмодзи по-разному. Поэтому может быть так, что на компьютере ваша картинка немного «сплющится», а на телефоне — на ней появятся полосы.\n\n' +
      'Влиять на это можно через паддинг — прозрачные отступы между эмодзи. Стандартный паддинг — 2px. Поменять паддинг можно кнопками "Паддинг -/+" при создании пака. Попробуйте разные значения и посмотрите, как картинки лучше выглядят на ваших устройствах.\n\n' +
      '🎬 <b>Анимированные эмодзи-паки</b>\n\n' +
      'На бесплатном тарифе можно создавать анимированные паки самого маленького размера (из 9-15 эмодзи). На платных тарифах можно создавать паки любого размера.\n\n' +
      'Видео и гифки должны быть длительностью до 3 секунд и меньше 10 МБ. Можно кидать боту гифки прямо из каталога гифок в Телеграме.\n\n' +
      'Для анимированных эмодзи лучше не выбирать большой размер сетки. У людей с медленным интернетом много эмодзи не успеются прогрузиться сразу — и анимация будет ломаться и рассинхронизироваться.\n\n' +
      'Рекомендуемый размер сетки — до 30-40 эмодзи. Например, 6×6 или 5×7.\n\n' +
      '💎 <b>Лимиты:</b>\n' +
      '• Бесплатный тариф: 5 обработок в месяц\n' +
      '• Pro тариф: безлимитные генерации\n\n' +
      '❓ Если у вас возникли проблемы или вопросы, свяжитесь с создателем бота: @Cheatb';
    
    const keyboard = Markup.keyboard([
      ['🔙 Главное меню'],
    ]).resize();
    
    await ctx.reply(helpMessage, { parse_mode: 'HTML', ...keyboard });
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

/**
 * Handle padding settings screen
 */
async function handlePaddingSettings(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handlePaddingSettings: no userId');
    return;
  }

  try {
    await ctx.answerCbQuery().catch(() => {});

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
      await ctx.reply('Превью не найдено. Отправьте новое изображение.', mainMenu).catch(() => {});
      return;
    }

    const currentPadding = pending.padding;

    const message = `⚙️ <b>Настройка паддинга</b>\n\n` +
      `Текущее значение: <b>${currentPadding}px</b>\n\n` +
      `📐 <b>Что такое паддинг?</b>\n\n` +
      `Паддинг — это прозрачные отступы между эмодзи.\n\n` +
      `На разных устройствах и клиентах Telegram отображает эмодзи по-разному. Поэтому может быть так, что на компьютере ваша картинка немного «сплющится», а на телефоне — на ней появятся полосы.\n\n` +
      `Влиять на это можно через паддинг — прозрачные полосы по краям эмодзи. Попробуйте разные значения и посмотрите, как картинки лучше выглядят на ваших устройствах.\n\n` +
      `Значение по умолчанию: <b>0px</b>`;

    // Создаем кнопки для выбора паддинга (0, 2, 4, 6, 8, 10, 12)
    const paddingValues = [0, 2, 4, 6, 8, 10, 12];
    const paddingButtons = paddingValues.map(value => {
      const label = value === currentPadding ? `✅ ${value}px` : `${value}px`;
      return Markup.button.callback(label, `pad:${value}`);
    });

    const keyboard = Markup.inlineKeyboard([
      paddingButtons.slice(0, 4), // Первая строка: 0, 2, 4, 6
      paddingButtons.slice(4), // Вторая строка: 8, 10, 12
      [Markup.button.callback('◀️ Назад к превью', 'padding:back')],
    ]);

    await ctx.reply(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Error in handlePaddingSettings');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

/**
 * Handle back button from padding settings
 */
async function handlePaddingBack(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handlePaddingBack: no userId');
    return;
  }

  try {
    await ctx.answerCbQuery().catch(() => {});

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
      await ctx.reply('Превью не найдено. Отправьте новое изображение.', mainMenu).catch(() => {});
      return;
    }

    // Удаляем сообщение с настройками паддинга
    await ctx.deleteMessage().catch(() => {});

    // Показываем превью снова
    const env = getEnv();
    await updatePreviewMessage(ctx, env, userId, pending);
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Error in handlePaddingBack');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
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

  const oldGrid = `${pending.grid.rows}x${pending.grid.cols}`;
  pending = {
    ...pending,
    grid: { rows: targetRows, cols: targetCols },
    isCustomGrid: false, // Сбрасываем флаг при выборе предложенной сетки
  };
  
  logger.info({ 
    userId, 
    oldGrid,
    newGrid: `${targetRows}x${targetCols}` 
  }, 'Updating grid in pending preview');

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

async function handleCustomGrid(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handleCustomGrid: no userId');
    return;
  }

  await ctx.answerCbQuery().catch(() => {});

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
    await ctx.reply('Превью не найдено. Отправьте файл заново.', mainMenu).catch(() => {});
    return;
  }

  // Создаем клавиатуру для выбора количества столбцов (1-15)
  // Количество строк будет вычислено автоматически для максимально квадратных тайлов
  const colButtons: any[] = [];
  for (let cols = 1; cols <= GRID_MAX; cols++) {
    colButtons.push(Markup.button.callback(`${cols}`, `grid:custom:cols:${cols}`));
  }

  const keyboard = Markup.inlineKeyboard([
    [{ text: `📐 Выберите количество столбцов (1-${GRID_MAX}):`, callback_data: 'grid:custom:info' }],
    [{ text: 'Количество строк будет вычислено автоматически', callback_data: 'grid:custom:info' }],
    colButtons.slice(0, 5),
    colButtons.slice(5, 10),
    colButtons.slice(10, 15),
    [{ text: '◀️ Назад', callback_data: 'grid:custom:back' }],
  ]);

  await ctx.reply(
    '📐 Выберите количество столбцов:\n\n' +
    `⚠️ Максимум ${GRID_MAX} столбцов.\n` +
    'Количество строк будет вычислено автоматически для максимально квадратных тайлов.\n\n' +
    `Текущая сетка: ${pending.grid.rows}×${pending.grid.cols}`,
    keyboard
  ).catch(() => {});
}

// Функция для вычисления оптимального количества строк на основе количества столбцов
// и размеров изображения для максимально квадратных тайлов
async function calculateOptimalRows(
  fileUrl: string,
  cols: number,
  fileType: 'image' | 'video' | 'animation'
): Promise<number> {
  try {
    const axios = (await import('axios')).default;
    const sharp = (await import('sharp')).default;
    
    // Загружаем файл для получения размеров
    const fileResponse = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const buffer = Buffer.from(fileResponse.data);
    
    let width: number;
    let height: number;
    
    if (fileType === 'video' || fileType === 'animation') {
      // Для видео используем дефолтные размеры или получаем из метаданных
      // Пока используем дефолтные, можно улучшить позже
      width = 512;
      height = 512;
    } else {
      // Для изображения получаем размеры из метаданных
      const metadata = await sharp(buffer).metadata();
      width = metadata.width || 512;
      height = metadata.height || 512;
    }
    
    // Вычисляем оптимальное количество строк для максимально квадратных тайлов
    // Ширина тайла: width / cols
    // Чтобы тайл был квадратным, высота тайла должна быть равна ширине тайла
    // Количество строк: height / (width / cols) = height * cols / width
    const optimalRows = Math.round((height * cols) / width);
    
    // Ограничиваем значениями от GRID_MIN до GRID_MAX
    return clamp(optimalRows, GRID_MIN, GRID_MAX);
  } catch (error: any) {
    logger.error({ err: error, fileUrl, cols }, 'Failed to calculate optimal rows');
    // В случае ошибки возвращаем количество столбцов (квадратная сетка)
    return clamp(cols, GRID_MIN, GRID_MAX);
  }
}

async function handleCustomGridSelect(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) {
    logger.warn('handleCustomGridSelect: no userId');
    return;
  }

  let match: RegExpMatchArray | string | null = ctx.match;
  
  logger.info({ userId, match, matchType: typeof match, isArray: Array.isArray(match) }, 'handleCustomGridSelect called');
  
  // Обработка нового формата: grid:custom:cols:N
  // ctx.match может быть массивом (при использовании регулярного выражения) или строкой
  if (Array.isArray(match) && match.length > 1) {
    // Если match - это массив из регулярного выражения /^grid:custom:cols:(\d+)$/
    // то match[0] - полное совпадение, match[1] - первая группа
    const selectedCols = parseInt(match[1], 10);
    if (!isNaN(selectedCols)) {
      
      if (selectedCols < GRID_MIN || selectedCols > GRID_MAX) {
        await ctx.answerCbQuery(`Количество столбцов должно быть от ${GRID_MIN} до ${GRID_MAX}`).catch(() => {});
        return;
      }
      
      await ctx.answerCbQuery('Вычисляю оптимальное количество строк...').catch(() => {});
      
      // Получаем pending для доступа к fileUrl
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
      
      // Вычисляем оптимальное количество строк
      const optimalRows = await calculateOptimalRows(pending.fileUrl, selectedCols, pending.fileType);
      
      logger.info({ 
        userId, 
        selectedCols, 
        optimalRows,
        fileUrl: pending.fileUrl.substring(0, 50)
      }, 'Calculated optimal rows for custom grid');
      
      // Применяем сетку с вычисленным количеством строк
      await applyCustomGrid(ctx, userId, optimalRows, selectedCols);
      return;
    }
  }
  
  // Также проверяем, если match - строка
  if (typeof match === 'string') {
    const colsMatch = match.match(/^grid:custom:cols:(\d+)$/);
    if (colsMatch) {
      const selectedCols = parseInt(colsMatch[1], 10);
      
      if (selectedCols < GRID_MIN || selectedCols > GRID_MAX) {
        await ctx.answerCbQuery(`Количество столбцов должно быть от ${GRID_MIN} до ${GRID_MAX}`).catch(() => {});
        return;
      }
      
      await ctx.answerCbQuery('Вычисляю оптимальное количество строк...').catch(() => {});
      
      // Получаем pending для доступа к fileUrl
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
      
      // Вычисляем оптимальное количество строк
      const optimalRows = await calculateOptimalRows(pending.fileUrl, selectedCols, pending.fileType);
      
      logger.info({ 
        userId, 
        selectedCols, 
        optimalRows,
        fileUrl: pending.fileUrl.substring(0, 50)
      }, 'Calculated optimal rows for custom grid');
      
      // Применяем сетку с вычисленным количеством строк
      await applyCustomGrid(ctx, userId, optimalRows, selectedCols);
      return;
    }
  }
  
  // Старый формат для обратной совместимости (можно удалить позже)
  if (typeof match === 'string') {
    const regexMatch = match.match(/^grid:custom:(\d+)x(\d+)$/);
    if (regexMatch) {
      match = regexMatch;
    }
  }

  if (!Array.isArray(match)) {
    if (match === 'grid:custom:back') {
      await ctx.answerCbQuery().catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    if (match === 'grid:custom:info') {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    await ctx.answerCbQuery('Ошибка: неверный выбор').catch(() => {});
    return;
  }
  
  // Старая логика для обратной совместимости (можно удалить позже)
  const selectedRows = parseInt(match[1], 10);
  const selectedCols = parseInt(match[2], 10);
  
  if (selectedRows > 0 && selectedCols > 0) {
    await applyCustomGrid(ctx, userId, selectedRows, selectedCols);
  }
}

async function applyCustomGrid(ctx: any, userId: number, rows: number, cols: number) {
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
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  const targetRows = clamp(rows, GRID_MIN, GRID_MAX);
  const targetCols = clamp(cols, GRID_MIN, GRID_MAX);

  logger.info({ 
    userId, 
    inputRows: rows, 
    inputCols: cols,
    targetRows, 
    targetCols,
    oldGrid: `${pending.grid.rows}x${pending.grid.cols}`
  }, 'Applying custom grid');

  if (pending.grid.rows === targetRows && pending.grid.cols === targetCols) {
    await ctx.answerCbQuery('Эта сетка уже выбрана').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  // ВАЖНО: Создаем новый объект pending с обновленными значениями
  // Это гарантирует, что updatePreviewMessage получит правильные значения
  const updatedPending: PendingPreview = {
    ...pending,
    grid: { rows: targetRows, cols: targetCols },
    isCustomGrid: true, // Помечаем как кастомную сетку
  };
  
  // Сохраняем выбор пользователя перед обновлением
  pendingPreviews.set(userId, updatedPending);
  
  logger.info({ 
    userId, 
    newPendingGrid: `${updatedPending.grid.rows}x${updatedPending.grid.cols}`,
    targetRows,
    targetCols,
    isCustomGrid: updatedPending.isCustomGrid,
    oldPendingGrid: `${pending.grid.rows}x${pending.grid.cols}`
  }, 'Pending grid updated before updatePreviewMessage');

  await ctx.answerCbQuery('Обновляю сетку...').catch(() => {});

  try {
    // Передаем обновленный pending с правильными значениями
    await updatePreviewMessage(ctx, env, userId, updatedPending);
    await ctx.answerCbQuery('Готово!').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  } catch (error: any) {
    logger.error({
      err: error,
      stack: error.stack,
      userId,
      targetRows,
      targetCols,
    }, 'Custom grid select error');

    pendingPreviews.set(userId, pending);

    const errorMessage = error.response?.data?.error || error.message || 'Неизвестная ошибка';
    await ctx.answerCbQuery(`Ошибка: ${errorMessage}`).catch(() => {});
    await ctx.deleteMessage().catch(() => {});
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
  ['📊 Статистика', '📈 Аналитика'],
  ['🔙 Главное меню'],
]).resize();

/**
 * Admin command handler
 */
// Генерация уникального реферального кода
function generateReferralCode(userId: bigint): string {
  // Используем последние 8 цифр userId + случайные символы для уникальности
  const userIdStr = userId.toString();
  const suffix = userIdStr.slice(-8);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ref_${suffix}${random}`;
}

// Получение или создание реферального кода пользователя
async function getOrCreateReferralCode(userId: bigint): Promise<string> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    if (user?.referralCode) {
      return user.referralCode;
    }

    // Генерируем новый код
    let code = generateReferralCode(userId);
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      try {
        await prisma.user.update({
          where: { id: userId },
          data: { referralCode: code },
        });
        logger.info({ userId, code }, 'Referral code created');
        return code;
      } catch (error: any) {
        // Если код уже существует, генерируем новый
        if (error.code === 'P2002') {
          code = generateReferralCode(userId);
          attempts++;
        } else {
          throw error;
        }
      }
    }

    // Если не удалось создать уникальный код, используем userId
    const fallbackCode = `ref_${userId}`;
    await prisma.user.update({
      where: { id: userId },
      data: { referralCode: fallbackCode },
    });
    return fallbackCode;
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Failed to get or create referral code');
    // Возвращаем fallback код
    return `ref_${userId}`;
  }
}

// Обработка реферальной регистрации
async function handleReferralRegistration(referredUserId: bigint, referralCode: string): Promise<void> {
  try {
    // Находим реферера по коду
    const referrer = await prisma.user.findUnique({
      where: { referralCode },
      select: { id: true },
    });

    if (!referrer) {
      logger.warn({ referralCode, referredUserId }, 'Referrer not found for referral code');
      return;
    }

    // Проверяем, что пользователь не приглашает сам себя
    if (referrer.id === referredUserId) {
      logger.warn({ userId: referredUserId, referralCode }, 'User tried to refer themselves');
      return;
    }

    // Проверяем, не был ли уже этот пользователь приглашен
    const existingReferral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
    });

    if (existingReferral) {
      logger.info({ referredUserId, referrerId: referrer.id }, 'User already referred');
      return;
    }

    // Создаем запись о реферале
    await prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredId: referredUserId,
        bonusGiven: false,
        createdAt: new Date(), // Явно указываем Date объект
      },
    });

    logger.info({ referrerId: referrer.id, referredUserId, referralCode }, 'Referral registration created');

    // Начисляем бонус рефереру (75 бонусов за приглашение, 300 = 1 месяц)
    const BONUS_PER_REFERRAL = 75;
    
    // Сначала начисляем бонус
    const updatedUser = await prisma.user.update({
      where: { id: referrer.id },
      data: {
        referralBonus: {
          increment: BONUS_PER_REFERRAL,
        },
      },
      select: {
        referralBonus: true,
      },
    });

    // Затем отмечаем, что бонус начислен
    await prisma.referral.updateMany({
      where: {
        referrerId: referrer.id,
        referredId: referredUserId,
        bonusGiven: false,
      },
      data: {
        bonusGiven: true,
      },
    });

    // Получаем обновленный баланс бонусов для логирования
    const updatedUserBalance = await prisma.user.findUnique({
      where: { id: referrer.id },
      select: { referralBonus: true },
    });

    logger.info({ 
      referrerId: referrer.id, 
      referredUserId, 
      bonus: BONUS_PER_REFERRAL,
      newBalance: updatedUserBalance?.referralBonus || 0
    }, 'Referral bonus awarded');
  } catch (error: any) {
    logger.error({ err: error, referredUserId, referralCode }, 'Failed to handle referral registration');
  }
}

async function upsertUserProfile(userId: bigint, username?: string, referralCode?: string) {
  const normalizedUsername = normalizeUsername(username);
  const existingUser = await prisma.user.findUnique({ where: { id: userId } });
  const isNewUser = !existingUser;
  
  try {
    const user = await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        status: 'FREE',
        ...(normalizedUsername ? { username: normalizedUsername } : {}),
        referralCode: generateReferralCode(userId), // Генерируем код при создании
      },
      update: normalizedUsername ? { username: normalizedUsername } : {},
    });
    
    logger.debug({ userId, username: normalizedUsername, isNewUser }, 'User profile upserted successfully');

    // Обрабатываем реферальный код:
    // 1. Если это новый пользователь и есть реферальный код
    // 2. Или если пользователь уже существует, но еще не был приглашен (нет записи в referrals)
    if (referralCode) {
      if (isNewUser) {
        // Новый пользователь - обрабатываем сразу
        await handleReferralRegistration(userId, referralCode);
      } else {
        // Существующий пользователь - проверяем, был ли он уже приглашен
        const existingReferral = await prisma.referral.findUnique({
          where: { referredId: userId },
        });
        if (!existingReferral) {
          // Пользователь еще не был приглашен - обрабатываем реферальный код
          await handleReferralRegistration(userId, referralCode);
        }
      }
    }
  } catch (error: any) {
    logger.error({ 
      err: error, 
      userId, 
      username: normalizedUsername,
      errorCode: error?.code,
      errorMessage: error?.message,
      stack: error?.stack,
    }, 'Failed to upsert user profile');
    // Не пробрасываем ошибку дальше, чтобы бот мог продолжать работу
  }
}

// Обработчик использования реферальных бонусов
async function handleUseReferralBonus(ctx: any) {
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    const match = ctx.match;
    if (!match || !match[1]) {
      await ctx.reply('❌ Ошибка: неверный формат запроса.', mainMenu);
      return;
    }

    const monthsToUse = parseInt(match[1], 10);
    if (isNaN(monthsToUse) || monthsToUse <= 0) {
      await ctx.reply('❌ Ошибка: неверное количество месяцев.', mainMenu);
      return;
    }

    const BONUS_FOR_MONTH = 300;
    const bonusNeeded = monthsToUse * BONUS_FOR_MONTH;

    const user = await prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { referralBonus: true, status: true, paidUntil: true },
    });

    if (!user) {
      await ctx.reply('❌ Ошибка при получении данных.', mainMenu);
      return;
    }

    const currentBonus = user.referralBonus || 0;
    if (currentBonus < bonusNeeded) {
      await ctx.reply(
        `❌ Недостаточно бонусов. У вас ${currentBonus}, нужно ${bonusNeeded}.\n\n` +
        `Пригласите еще ${Math.ceil((bonusNeeded - currentBonus) / 75)} пользователей!`,
        mainMenu
      );
      return;
    }

    // Списываем бонусы
    const newBonus = currentBonus - bonusNeeded;
    await prisma.user.update({
      where: { id: BigInt(userId) },
      data: { referralBonus: newBonus },
    });

    // Выдаем подписку
    const now = new Date();
    const currentPaidUntil = user.paidUntil && user.paidUntil > now ? user.paidUntil : now;
    const newPaidUntil = new Date(currentPaidUntil);
    newPaidUntil.setDate(newPaidUntil.getDate() + (monthsToUse * 30));

    await prisma.user.update({
      where: { id: BigInt(userId) },
      data: {
        status: 'PRO',
        paidUntil: newPaidUntil,
      },
    });

    logger.info({ 
      userId, 
      monthsToUse, 
      bonusUsed: bonusNeeded, 
      newBonus,
      newPaidUntil 
    }, 'Referral bonus used for subscription');

    await ctx.reply(
      `✅ Успешно!\n\n` +
      `💎 Использовано бонусов: ${bonusNeeded}\n` +
      `📅 Подписка Pro продлена до: ${newPaidUntil.toLocaleDateString('ru-RU')}\n` +
      `🎁 Осталось бонусов: ${newBonus}`,
      mainMenu
    );
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleUseReferralBonus');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
  }
}

// Обработчик реферальной программы
async function handleReferralProgram(ctx: any) {
  try {
    const userId = ctx.from?.id;
    if (!userId) return;

    const user = await prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: {
        referralCode: true,
        referralBonus: true,
        ReferralsAsReferrer: {
          select: {
            id: true,
            createdAt: true,
            referredId: true,
            bonusGiven: true,
          },
        },
      },
    });

    if (!user) {
      await ctx.reply('❌ Ошибка при получении данных.', mainMenu);
      return;
    }

    const referralCode = user.referralCode || await getOrCreateReferralCode(BigInt(userId));
    const totalReferrals = user.ReferralsAsReferrer.length;
    const bonusAmount = user.referralBonus || 0;
    
    // Логируем для отладки
    logger.info({ 
      userId, 
      referralCode, 
      totalReferrals, 
      bonusAmount,
      referralsWithBonus: user.ReferralsAsReferrer.filter(r => r.bonusGiven).length
    }, 'Referral program stats');
    const BONUS_FOR_MONTH = 300; // 300 бонусов = 1 месяц Pro
    const monthsAvailable = Math.floor(bonusAmount / BONUS_FOR_MONTH);
    const bonusRemainder = bonusAmount % BONUS_FOR_MONTH;

    const botUsername = process.env.TG_BOT_USERNAME || 'RaspilPakBot';
    const referralLink = `https://t.me/${botUsername}?start=${referralCode}`;

    let message = '🎁 <b>Реферальная программа</b>\n\n';
    message += `📊 <b>Статистика:</b>\n`;
    message += `• Приглашено пользователей: ${totalReferrals}\n`;
    message += `• Накоплено бонусов: ${bonusAmount}\n`;
    message += `• Доступно месяцев Pro: ${monthsAvailable}\n\n`;
    
    if (bonusRemainder > 0) {
      message += `💎 До следующего месяца осталось: ${BONUS_FOR_MONTH - bonusRemainder} бонусов\n\n`;
    }

    message += `📝 <b>Как это работает:</b>\n`;
    message += `• За каждого приглашенного пользователя вы получаете 75 бонусов\n`;
    message += `• 4 приглашения = 300 бонусов = 1 месяц Pro подписки\n`;
    message += `• Бонусы можно использовать для покупки Pro подписки\n\n`;

    message += `🔗 <b>Ваша реферальная ссылка:</b>\n`;
    message += `<code>${referralLink}</code>\n\n`;
    message += `📋 <b>Текст для приглашения:</b>\n`;
    message += `Привет! Попробуй этого бота для создания эмодзипаков:\n${referralLink}`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.url('📤 Поделиться ссылкой', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Попробуй этого бота для создания эмодзипаков!')}`),
      ],
      ...(monthsAvailable > 0 ? [
        [Markup.button.callback(`💎 Использовать бонусы (${monthsAvailable} мес.)`, `referral:use:${monthsAvailable}`)],
      ] : []),
      [Markup.button.callback('🔙 Главное меню', 'main_menu')],
    ]);

    await ctx.reply(message, { parse_mode: 'HTML', ...keyboard });
  } catch (error: any) {
    logger.error({ err: error }, 'Error in handleReferralProgram');
    await ctx.reply('Произошла ошибка. Попробуйте позже.', mainMenu).catch(() => {});
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
      `  Планы: PRO\n\n` +
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
        `Планы: PRO\n` +
        `Если срок не указан, используется 30 дней`
      , adminMenu
      );
      return;
    }

    const rawTarget = commandArgs[1];
    const planRaw = commandArgs[2].toUpperCase();
    const daysArg = commandArgs[3];
    const parsedDays = daysArg ? parseInt(daysArg, 10) : 30;
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : NaN;

    // Поддерживаем MAX для обратной совместимости, но конвертируем в PRO
    if (planRaw !== 'PRO' && planRaw !== 'MAX') {
      await ctx.reply('❌ Неверный план. Используйте PRO.', adminMenu);
      return;
    }
    
    // Все платные тарифы теперь PRO
    const plan: 'PRO' = 'PRO';

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

/**
 * Analytics handler
 */
async function handleAnalytics(ctx: any) {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const username = ctx.from?.username;
    const admin = await isAdmin(BigInt(userId), username);
    if (!admin) {
      await ctx.reply('❌ У вас нет доступа.', mainMenu);
      return;
    }

    // Общая статистика
    const totalUsers = await prisma.user.count();
    
    // Платные пользователи - это уникальные пользователи, которые когда-либо совершили успешный платеж
    const paidUsersResult = await prisma.payment.findMany({
      where: {
        status: 'PAID',
      },
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });
    const paidUsers = paidUsersResult.length;

    // Общая сумма заработанных денег
    // ВНИМАНИЕ: В старых данных amount может быть в рублях (< 1000), в новых - в копейках (>= 100)
    // Нужно обработать оба случая
    const allPaidPayments = await prisma.payment.findMany({
      where: {
        status: 'PAID',
      },
      select: {
        amount: true,
      },
    });
    
    let totalRevenueKopecks = 0;
    allPaidPayments.forEach((payment) => {
      const amount = Number(payment.amount);
      // Логика определения формата на основе реальных данных:
      // - 299, 1990 - это рубли (старые данные) - умножаем на 100
      // - 29900, 19900 - это копейки (новые данные) - используем как есть
      if (amount === 299 || amount === 1990) {
        // Типичные цены подписки в рублях (старые данные)
        totalRevenueKopecks += amount * 100;
      } else if (amount >= 10000) {
        // >= 10000 - точно копейки (29900, 19900)
        totalRevenueKopecks += amount;
      } else {
        // Остальные случаи - по умолчанию считаем копейками
        totalRevenueKopecks += amount;
      }
    });
    
    const totalRevenueRub = (totalRevenueKopecks / 100).toFixed(2);

    // Статистика по месяцам
    // Получаем всех пользователей и группируем по месяцам регистрации
    const allUsers = await prisma.user.findMany({
      select: {
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Получаем все платежи для подсчета платных пользователей и выручки
    const allPayments = await prisma.payment.findMany({
      where: {
        status: 'PAID',
      },
      select: {
        createdAt: true,
        amount: true,
        userId: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Группируем пользователей по месяцам регистрации
    const monthlyDataMap = new Map<string, { users: number; paidUsers: number; revenue: number }>();
    
    allUsers.forEach((user) => {
      const month = `${user.createdAt.getFullYear()}-${String(user.createdAt.getMonth() + 1).padStart(2, '0')}`;
      const data = monthlyDataMap.get(month) || { users: 0, paidUsers: 0, revenue: 0 };
      data.users += 1;
      monthlyDataMap.set(month, data);
    });

    // Группируем платежи по месяцам и считаем уникальных платных пользователей
    const paidUsersByMonth = new Map<string, Set<bigint>>();
    
    allPayments.forEach((payment) => {
      const month = `${payment.createdAt.getFullYear()}-${String(payment.createdAt.getMonth() + 1).padStart(2, '0')}`;
      const data = monthlyDataMap.get(month) || { users: 0, paidUsers: 0, revenue: 0 };
      // Обрабатываем amount так же, как в общем подсчете
      const amount = Number(payment.amount);
      let amountKopecks = 0;
      if (amount < 100) {
        amountKopecks = amount * 100;
      } else if (amount < 1000) {
        if (amount === 299 || amount === 1990) {
          amountKopecks = amount * 100;
        } else {
          amountKopecks = amount;
        }
      } else {
        amountKopecks = amount;
      }
      data.revenue += amountKopecks / 100; // Конвертируем из копеек в рубли
      
      // Считаем уникальных платных пользователей в этом месяце
      if (!paidUsersByMonth.has(month)) {
        paidUsersByMonth.set(month, new Set());
      }
      paidUsersByMonth.get(month)!.add(payment.userId);
      
      monthlyDataMap.set(month, data);
    });

    // Обновляем количество платных пользователей по месяцам
    paidUsersByMonth.forEach((userIds, month) => {
      const data = monthlyDataMap.get(month);
      if (data) {
        data.paidUsers = userIds.size;
      }
    });

    // Форматируем месяцы для отображения
    const formatMonth = (monthStr: string) => {
      const [year, month] = monthStr.split('-');
      const monthNames = [
        'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
      ];
      return `${monthNames[parseInt(month, 10) - 1]} ${year}`;
    };

    // Статистика по дням (последние 30 дней)
    const dailyDataMap = new Map<string, number>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    for (let i = 0; i < 30; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      dailyDataMap.set(dateStr, 0);
    }
    
    allUsers.forEach((user) => {
      const userDate = new Date(user.createdAt);
      userDate.setHours(0, 0, 0, 0);
      const dateStr = `${userDate.getFullYear()}-${String(userDate.getMonth() + 1).padStart(2, '0')}-${String(userDate.getDate()).padStart(2, '0')}`;
      if (dailyDataMap.has(dateStr)) {
        dailyDataMap.set(dateStr, (dailyDataMap.get(dateStr) || 0) + 1);
      }
    });

    // Формируем сообщение
    let message = `📈 *Аналитика бота*\n\n`;
    message += `📊 *Общая статистика:*\n`;
    message += `• Всего пользователей: ${totalUsers}\n`;
    message += `• Платных пользователей: ${paidUsers}\n`;
    message += `• Всего заработано: ${totalRevenueRub} ₽\n\n`;

    message += `📅 *Новые пользователи по дням (последние 30 дней):*\n\n`;
    
    // Сортируем дни по убыванию
    const sortedDays = Array.from(dailyDataMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30);
    
    if (sortedDays.length === 0) {
      message += `Нет данных по дням.\n\n`;
    } else {
      sortedDays.forEach(([dateStr, count]) => {
        const [year, month, day] = dateStr.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        const dayName = date.toLocaleDateString('ru-RU', { weekday: 'short' });
        message += `• ${day}.${month}.${year} (${dayName}): ${count}\n`;
      });
      message += `\n`;
    }

    message += `📅 *Статистика по месяцам (последние 12):*\n\n`;

    // Сортируем месяцы по убыванию
    const sortedMonths = Array.from(monthlyDataMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 12);

    if (sortedMonths.length === 0) {
      message += `Нет данных по месяцам.\n`;
    } else {
      sortedMonths.forEach(([month, data]) => {
        message += `*${formatMonth(month)}:*\n`;
        message += `  👥 Пользователей: ${data.users}\n`;
        message += `  💎 Платных: ${data.paidUsers}\n`;
        message += `  💰 Заработано: ${data.revenue.toFixed(2)} ₽\n\n`;
      });
    }

    await ctx.reply(message, { ...adminMenu, parse_mode: 'Markdown' });
  } catch (error: any) {
    logger.error({ err: error, userId }, 'Analytics error');
    await ctx.reply('❌ Ошибка при получении аналитики.', adminMenu);
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

