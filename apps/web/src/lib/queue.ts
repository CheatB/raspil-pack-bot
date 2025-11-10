import { splitImageToPngTiles, splitVideoToTiles } from '@repo/processor';
import { addStickerToSet, createEmojiSet } from '@repo/tg-bot/stickers';
import { prisma } from '@/lib/prisma';

const botToken = process.env.TG_BOT_TOKEN;
if (!botToken) {
  throw new Error('TG_BOT_TOKEN is not set');
}

async function sendTelegramMessage(chatId: number, text: string, parseMode: 'HTML' | 'MarkdownV2' | undefined = undefined) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
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

async function processPackJob(data: PackJobData): Promise<{ link: string; packId: string }> {
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

    const rawBotUsername = process.env.TG_BOT_USERNAME ?? 'RaspilPakBot';
    const botUsernameSlug = rawBotUsername.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    const packNameBase = `raspil_${userId}_${Date.now()}`;
    const packName = `${packNameBase}_by_${botUsernameSlug}`;
    const packTitle = removeBranding ? 'Raspil Pack' : 'Raspil Pack | Автор @prostochelокек';

    const [firstTile, ...restTiles] = tiles;

    await createEmojiSet(userId, packTitle, packName, firstTile, {
      format: stickerFormat,
      contentType,
      fileName: `tile0.${fileExtension}`,
    });

    for (const tile of restTiles) {
      await addStickerToSet(userId, packName, tile, {
        format: stickerFormat,
        contentType,
        fileName: `tile.${fileExtension}`,
      });
    }

    const createdTiles = 1 + restTiles.length;

    const link = `https://t.me/addstickers/${packName}`;

    await prisma.pack.update({
      where: { id: packRecord.id },
      data: {
        tilesCount: createdTiles,
        setName: packName,
        setLink: link,
        status: 'READY',
      },
    });

    return { link, packId: packRecord.id };
  } catch (error) {
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

async function notifySuccess(userId: number, link: string) {
  const message =
    '✅ Пак создан! Добавь его в Telegram, затем вставляй эмодзи по сетке.\n' +
    'Если хочешь без брендинга и с большими сетками — оформи Pro/Max 💎\n\n' +
    link;

  await sendTelegramMessage(userId, message);
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
      await notifySuccess(jobData.userId, result.link);
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