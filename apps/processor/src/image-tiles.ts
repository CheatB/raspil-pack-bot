import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { ensureFfmpegReady } from './video';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function splitImageToPngTiles(
  buffer: Buffer,
  rows: number,
  cols: number,
  padding: number = 2
): Promise<{ tiles: Buffer[] }> {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const width = metadata.width ?? 512;
  const height = metadata.height ?? 512;

  const normalizedPadding = Math.max(0, Math.min(20, Math.round(padding)));
  
  // Вычисляем доступную область с учетом padding
  const availableWidth = width - normalizedPadding * (cols - 1);
  const availableHeight = height - normalizedPadding * (rows - 1);
  
  // Базовые размеры тайлов (без остатка)
  const baseTileWidth = Math.max(1, Math.floor(availableWidth / cols));
  const baseTileHeight = Math.max(1, Math.floor(availableHeight / rows));
  
  // Остаток пикселей для равномерного распределения
  const extraWidth = availableWidth - baseTileWidth * cols;
  const extraHeight = availableHeight - baseTileHeight * rows;
  
  // Массивы размеров тайлов с учетом остатка
  const columnWidths = Array.from({ length: cols }, (_, i) => 
    baseTileWidth + (i < extraWidth ? 1 : 0)
  );
  const rowHeights = Array.from({ length: rows }, (_, i) => 
    baseTileHeight + (i < extraHeight ? 1 : 0)
  );
  
  // Массивы смещений для каждой колонки и строки
  // Вычисляем смещения правильно: для колонки i смещение = сумма ширин всех предыдущих колонок
  const columnOffsets: number[] = [0];
  for (let i = 1; i < cols; i++) {
    columnOffsets[i] = columnOffsets[i - 1] + columnWidths[i - 1];
  }
  
  const rowOffsets: number[] = [0];
  for (let i = 1; i < rows; i++) {
    rowOffsets[i] = rowOffsets[i - 1] + rowHeights[i - 1];
  }

  const tiles: Buffer[] = [];

  // ВАЖНО: Порядок должен быть row-first (сначала все тайлы первой строки, потом второй и т.д.)
  // Это соответствует порядку в Telegram эмодзи-паках
  // Порядок: tile[0] = (row=0, col=0), tile[1] = (row=0, col=1), ..., tile[cols-1] = (row=0, col=cols-1),
  //          tile[cols] = (row=1, col=0), tile[cols+1] = (row=1, col=1), ...
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileIndex = row * cols + col;
      const offsetX = columnOffsets[col] ?? 0;
      const offsetY = rowOffsets[row] ?? 0;
      const tileWidth = columnWidths[col] ?? baseTileWidth;
      const tileHeight = rowHeights[row] ?? baseTileHeight;
      
      // Добавляем padding к смещению
      // Для колонки col: padding добавляется col раз (между колонками 0-1, 1-2, ..., (col-1)-col)
      // Для строки row: padding добавляется row раз (между строками 0-1, 1-2, ..., (row-1)-row)
      const left = offsetX + col * normalizedPadding;
      const top = offsetY + row * normalizedPadding;
      
      // ВАЖНО: Убеждаемся, что тайлы покрывают всю область без промежутков
      // Для последнего тайла в строке/столбце расширяем размер, чтобы покрыть всю оставшуюся область
      const isLastCol = col === cols - 1;
      const isLastRow = row === rows - 1;
      const actualTileWidth = isLastCol ? width - left : tileWidth;
      const actualTileHeight = isLastRow ? height - top : tileHeight;
      
      // Логирование для отладки (только для первых нескольких тайлов)
      if (tileIndex < 5 || (tileIndex >= rows * cols - 5)) {
        console.log(`[splitImageToPngTiles] Tile ${tileIndex} (row=${row}, col=${col}): left=${left}, top=${top}, width=${tileWidth}, height=${tileHeight}`);
      }

      // ВАЖНО: Извлекаем тайл точно по вычисленным границам без потери пикселей
      // Используем actualTileWidth и actualTileHeight для последних тайлов, чтобы покрыть всю область
      const extractLeft = Math.max(0, Math.min(Math.floor(left), width - 1));
      const extractTop = Math.max(0, Math.min(Math.floor(top), height - 1));
      // Убеждаемся, что мы не выходим за границы изображения
      // Для последних тайлов используем actualTileWidth/Height, чтобы покрыть всю оставшуюся область
      const extractWidth = Math.max(1, Math.min(Math.ceil(actualTileWidth), width - extractLeft));
      const extractHeight = Math.max(1, Math.min(Math.ceil(actualTileHeight), height - extractTop));

      const tileBuffer = await image
        .clone()
        .extract({
          left: extractLeft,
          top: extractTop,
          width: extractWidth,
          height: extractHeight,
        })
        // ВАЖНО: Telegram требует квадратные PNG стикеры (100x100)
        // Используем 'cover' с правильным позиционированием, чтобы заполнить весь квадрат
        // без обрезки важных частей изображения
        .resize(100, 100, {
          fit: 'cover', // Заполняем весь квадрат
          position: 'center', // Центрируем при обрезке
        })
        .toBuffer();

      // Конвертируем в PNG без прозрачности, чтобы избежать черных полос
      // Используем RGB формат, так как Telegram может некорректно отображать прозрачность
      const pngTile = await sharp(tileBuffer)
        .removeAlpha() // Убираем альфа-канал, чтобы избежать проблем с прозрачностью
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
        })
        .toBuffer();

      tiles.push(pngTile);
    }
  }

  return { tiles };
}

async function pngBufferToWebm(buffer: Buffer): Promise<Buffer> {
  ensureFfmpegReady();

  const tmpInput = path.join('/tmp', `tile-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const tmpOutput = path.join('/tmp', `tile-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`);

  await fs.promises.writeFile(tmpInput, buffer);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(tmpInput)
        .inputOptions(['-loop', '1'])
        .outputOptions([
          '-c:v', 'libvpx-vp9',
          '-pix_fmt', 'yuva420p',
          '-b:v', '500k',
          '-t', '1',
          '-r', '30',
          '-an',
        ])
        .output(tmpOutput)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    return await fs.promises.readFile(tmpOutput);
  } finally {
    await fs.promises.unlink(tmpInput).catch(() => {});
    await fs.promises.unlink(tmpOutput).catch(() => {});
  }
}

export async function splitImageToWebmTiles(
  buffer: Buffer,
  rows: number,
  cols: number,
  padding: number = 2
): Promise<{ tiles: Buffer[] }> {
  const { tiles: pngTiles } = await splitImageToPngTiles(buffer, rows, cols, padding);
  const tiles: Buffer[] = [];

  for (const pngTile of pngTiles) {
    const webmTile = await pngBufferToWebm(pngTile);
    tiles.push(webmTile);
  }

  return { tiles };
}
