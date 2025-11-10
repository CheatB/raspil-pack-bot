import FormData from 'form-data';
import { Readable } from 'stream';

type FetchFn = typeof import('node-fetch')['default'];

let cachedFetch: FetchFn | null = null;

async function getFetch(): Promise<FetchFn> {
  if (!cachedFetch) {
    const mod = await import('node-fetch');
    cachedFetch = mod.default;
  }
  return cachedFetch;
}

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  throw new Error('TG_BOT_TOKEN is not set');
}

const API_BASE = `https://api.telegram.org/bot${token}`;

type StickerUploadOptions = {
  format: 'static' | 'video';
  contentType: string;
  fileName?: string;
  emoji?: string;
};

/**
 * Создаёт новый кастомный эмодзи-пак для пользователя
 */
export async function createEmojiSet(
  userId: number,
  title: string,
  name: string,
  file: Buffer,
  options: StickerUploadOptions
): Promise<boolean> {
  const { format, contentType, fileName = format === 'video' ? 'tile0.webm' : 'tile0.webp', emoji = '🧩' } = options;
  const url = `${API_BASE}/createNewStickerSet`;
  const form = new FormData();

  form.append('user_id', userId.toString());
  form.append('name', name);
  form.append('title', title);
  form.append('sticker_format', format);
  form.append('sticker_type', 'custom_emoji');
  form.append(
    'stickers',
    JSON.stringify([
      {
        sticker: 'attach://file0',
        emoji_list: [emoji],
      },
    ])
  );
  form.append('file0', Readable.from(file), {
    filename: fileName,
    contentType,
  });

  const fetch = await getFetch();
  const res = await fetch(url, { method: 'POST', body: form as any });
  const json = (await res.json()) as any;

  if (!json.ok) {
    throw new Error('Ошибка создания сета: ' + JSON.stringify(json));
  }

  return true;
}

/**
 * Добавляет один WEBM-тайл как эмодзи в набор
 */
export async function addStickerToSet(
  userId: number,
  setName: string,
  file: Buffer,
  options: StickerUploadOptions
): Promise<boolean> {
  const { format, contentType, fileName = format === 'video' ? 'tile.webm' : 'tile.webp', emoji = '🧩' } = options;
  const url = `${API_BASE}/addStickerToSet`;
  const form = new FormData();

  form.append('user_id', userId.toString());
  form.append('name', setName);
  form.append(
    'sticker',
    JSON.stringify({
      sticker: 'attach://file0',
      emoji_list: [emoji],
    })
  );
  form.append('file0', Readable.from(file), {
    filename: fileName,
    contentType,
  });

  const fetch = await getFetch();
  const res = await fetch(url, { method: 'POST', body: form as any });
  const json = (await res.json()) as any;

  if (!json.ok) {
    throw new Error('Ошибка добавления эмодзи: ' + JSON.stringify(json));
  }

  return true;
}
