import { splitImageToPngTiles, splitVideoToTiles } from '@repo/processor';
import { addStickerToSet, createEmojiSet } from '@repo/tg-bot/stickers';
import { prisma } from '@/lib/prisma';

const botToken = process.env.TG_BOT_TOKEN;
if (!botToken) {
  throw new Error('TG_BOT_TOKEN is not set');
}

async function sendTelegramMessage(
  chatId: number, 
  text: string, 
  parseMode: 'HTML' | 'MarkdownV2' | undefined = undefined,
  replyMarkup?: any
) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  };
  
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export type PackJobData = {
  fileUrl: string;
  userId: number;
  removeBranding?: boolean;
  packId?: string;
  gridRows: number;
  gridCols: number;
  padding: number;
  mediaType: 'image' | 'video';
};

async function processPackJob(data: PackJobData): Promise<{ link: string; packId: string; isAddingToExisting: boolean }> {
  const { fileUrl, userId, removeBranding = false } = data;

  let packRecord = data.packId ? await prisma.pack.findUnique({ where: { id: data.packId } }) : null;

  if (!packRecord) {
    packRecord = await prisma.pack.create({
      data: {
        userId: BigInt(userId),
        kind: data.mediaType === 'image' ? 'STATIC' : 'ANIMATED',
        gridRows: data.gridRows,
        gridCols: data.gridCols,
        padding: data.padding,
        tilesCount: 0,
        status: 'PROCESSING',
      },
    });
  } else if (packRecord.status !== 'PROCESSING') {
    await prisma.pack.update({
      where: { id: packRecord.id },
      data: { status: 'PROCESSING' },
    });
  }

  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      console.error('[queue] Failed to download media', {
        url: fileUrl,
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const rows = Math.max(1, data.gridRows || 3);
    const cols = Math.max(1, data.gridCols || 3);
    const padding = Math.max(0, data.padding ?? 2);

    let tiles: Buffer[] = [];
    let stickerFormat: 'static' | 'video' = 'video';
    let contentType = 'video/webm';
    let fileExtension = 'webm';

    if (data.mediaType === 'image') {
      const result = await splitImageToPngTiles(buffer, rows, cols, padding);
      tiles = result.tiles;
      stickerFormat = 'static';
      contentType = 'image/png';
      fileExtension = 'png';
    } else {
      const result = await splitVideoToTiles(buffer, rows, cols);
      tiles = result.tiles;
      stickerFormat = 'video';
      contentType = 'video/webm';
      fileExtension = 'webm';
    }

    if (!tiles.length) {
      throw new Error('Не удалось нарезать тайлы');
    }

    console.log(`[queue] Generated ${tiles.length} tiles for grid ${rows}x${cols} (expected: ${rows * cols})`);
    
    // ВАЖНО: Проверяем порядок тайлов - они должны быть в порядке row-first
    // (сначала все тайлы первой строки, потом второй и т.д.)
    if (tiles.length !== rows * cols) {
      console.warn(`[queue] WARNING: Tile count mismatch! Expected ${rows * cols}, got ${tiles.length}`);
    }
    console.log(`[queue] Tiles order: row-first (row 0: tiles 0-${cols - 1}, row 1: tiles ${cols}-${cols * 2 - 1}, etc.)`);

    // Определяем, добавляем ли в существующий пак или создаем новый
    const isAddingToExisting = packRecord.setName && packRecord.status === 'READY';
    let packName: string;
    let link: string;

    if (isAddingToExisting) {
      // Используем существующий набор
      packName = packRecord.setName;
      link = packRecord.setLink || `https://t.me/addstickers/${packName}`;
      console.log(`[queue] Adding to existing pack: ${packName}`);
    } else {
      // Создаем новый набор
      const rawBotUsername = process.env.TG_BOT_USERNAME ?? 'RaspilPakBot';
      const botUsernameSlug = rawBotUsername.replace(/[^a-z0-9_]/gi, '').toLowerCase();
      const packNameBase = `raspil_${userId}_${Date.now()}`;
      packName = `${packNameBase}_by_${botUsernameSlug}`;
      const packTitle = removeBranding ? 'Raspil Pack' : 'Raspil Pack | Автор @prostochelokek';

      const [firstTile, ...restTiles] = tiles;
      console.log(`[queue] Creating new pack: ${packName}, first tile ready, ${restTiles.length} tiles to add`);

      await createEmojiSet(userId, packTitle, packName, firstTile, {
        format: stickerFormat,
        contentType,
        fileName: `tile0.${fileExtension}`,
      });

      let addedCount = 0;
      for (let i = 0; i < restTiles.length; i++) {
        const tile = restTiles[i];
        try {
          await addStickerToSet(userId, packName, tile, {
            format: stickerFormat,
            contentType,
            fileName: `tile${i + 1}.${fileExtension}`,
          });
          addedCount++;
          console.log(`[queue] Added tile ${i + 1}/${restTiles.length}`);
        } catch (error: any) {
          console.error(`[queue] Failed to add tile ${i + 1}:`, error.message);
          // Продолжаем добавлять остальные тайлы даже если один не добавился
        }
      }
      console.log(`[queue] Successfully added ${addedCount} tiles out of ${restTiles.length}`);

      const createdTiles = 1 + addedCount;
      link = `https://t.me/addstickers/${packName}`;

      await prisma.pack.update({
        where: { id: packRecord.id },
        data: {
          tilesCount: createdTiles,
          setName: packName,
          setLink: link,
          status: 'READY',
        },
      });
    }

    // Добавляем тайлы в существующий набор
    if (isAddingToExisting) {
      const existingTilesCount = packRecord.tilesCount || 0;
      let addedCount = 0;
      
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        try {
          await addStickerToSet(userId, packName, tile, {
            format: stickerFormat,
            contentType,
            fileName: `tile${existingTilesCount + i}.${fileExtension}`,
          });
          addedCount++;
          console.log(`[queue] Added tile ${i + 1}/${tiles.length} to existing pack`);
        } catch (error: any) {
          console.error(`[queue] Failed to add tile ${i + 1} to existing pack:`, error.message);
          // Продолжаем добавлять остальные тайлы даже если один не добавился
        }
      }
      
      console.log(`[queue] Successfully added ${addedCount} tiles to existing pack out of ${tiles.length}`);
      
      const newTilesCount = existingTilesCount + addedCount;

      await prisma.pack.update({
        where: { id: packRecord.id },
        data: {
          tilesCount: newTilesCount,
          status: 'READY',
        },
      });
    }

    return { link, packId: packRecord.id, isAddingToExisting };
  } catch (error: any) {
    console.error('[queue] processPackJob error:', {
      error: error?.message,
      stack: error?.stack,
      userId: data.userId,
      mediaType: data.mediaType,
    });
    try {
      await prisma.pack.update({
        where: { id: packRecord!.id },
        data: { status: 'FAILED' },
      });
    } catch (updateError) {
      console.error('Failed to mark pack as FAILED:', updateError);
    }
    throw error;
  }
}

async function notifySuccess(userId: number, link: string, isAddingToExisting: boolean = false) {
  // Проверяем статус пользователя
  const user = await prisma.user.findUnique({
    where: { id: BigInt(userId) },
    select: { status: true },
  });

  const isFreeUser = !user || user.status === 'FREE';

  let message: string;
  if (isAddingToExisting) {
    message =
      '✅ Эмодзи добавлены в существующий пак!\n\n' +
      link +
      '\n\n📢 Присоединяйся к каналу создателя бота: @prostochelokek';
  } else {
    message =
      '✅ Пак создан! Добавь его в Telegram, затем вставляй эмодзи по сетке.\n' +
      'Если хочешь без брендинга и с большими сетками — оформи Pro/Max 💎\n\n' +
      link +
      '\n\n📢 Присоединяйся к каналу создателя бота: @prostochelokek';
  }

  let replyMarkup: any = undefined;
  
  if (isFreeUser && !isAddingToExisting) {
    // Добавляем inline кнопку для бесплатных пользователей только при создании нового пака
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '💰 Приобрести подписку',
            callback_data: 'tariffs:show'
          }
        ]
      ]
    };
  }

  await sendTelegramMessage(userId, message, undefined, replyMarkup);
}

async function notifyFailure(userId: number) {
  await sendTelegramMessage(userId, '❌ Не удалось создать эмодзи-пак. Попробуй ещё раз позже или поменяй видео.');
}

const inMemoryQueue: PackJobData[] = [];
let inMemoryProcessing = false;

async function processInMemoryQueue() {
  if (inMemoryProcessing) return;
  inMemoryProcessing = true;

  console.log('[queue] processing jobs', inMemoryQueue.length);

  while (inMemoryQueue.length > 0) {
    const jobData = inMemoryQueue.shift()!;
    try {
      const result = await processPackJob(jobData);
      await notifySuccess(jobData.userId, result.link, result.isAddingToExisting);
    } catch (error) {
      console.error('In-memory job failed:', error);
      await notifyFailure(jobData.userId);
    }
  }

  inMemoryProcessing = false;
}

export async function enqueuePackJob(data: PackJobData) {
  console.log('[queue] enqueue job', { userId: data.userId, mediaType: data.mediaType });
  inMemoryQueue.push(data);
  void processInMemoryQueue();
  return { jobId: null };
}