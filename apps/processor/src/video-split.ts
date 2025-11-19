import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { processTransparentImage } from './transparency';
import { ensureFfmpegReady } from './video';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Нарезает видео на анимированные WEBM-тайлы (для Telegram эмодзи)
 * @param buffer входной файл (видео/gif)
 * @param rows количество строк
 * @param cols количество столбцов
 * @returns {Promise<{tiles: Buffer[], preview: Buffer}>}
 */
export async function splitVideoToTiles(
  buffer: Buffer,
  rows: number,
  cols: number
): Promise<{ tiles: Buffer[]; preview: Buffer }> {
  ensureFfmpegReady();

  const tmpInput = path.join('/tmp', `input-${Date.now()}.mp4`);
  await fs.promises.writeFile(tmpInput, buffer);

  try {
    const meta = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
      ffmpeg.ffprobe(tmpInput, (err, data) => {
        if (err) return reject(err);
        const videoStream = data.streams.find((stream) => stream.codec_type === 'video');
        if (!videoStream || !videoStream.width || !videoStream.height) {
          return reject(new Error('Video stream metadata not found'));
        }
        const duration = data.format.duration ?? 0;
        resolve({
          width: videoStream.width,
          height: videoStream.height,
          duration,
        });
      });
    });

    const baseTileWidth = Math.floor(meta.width / cols);
    const extraWidth = meta.width - baseTileWidth * cols;
    const columnWidths = Array.from({ length: cols }, (_, i) => baseTileWidth + (i < extraWidth ? 1 : 0));
    const columnOffsets = columnWidths.reduce<number[]>((acc, _width, idx) => {
      acc.push((acc[idx - 1] ?? 0) + (idx === 0 ? 0 : columnWidths[idx - 1]));
      return acc;
    }, []);

    const baseTileHeight = Math.floor(meta.height / rows);
    const extraHeight = meta.height - baseTileHeight * rows;
    const rowHeights = Array.from({ length: rows }, (_, i) => baseTileHeight + (i < extraHeight ? 1 : 0));
    const rowOffsets = rowHeights.reduce<number[]>((acc, _height, idx) => {
      acc.push((acc[idx - 1] ?? 0) + (idx === 0 ? 0 : rowHeights[idx - 1]));
      return acc;
    }, []);

    const tiles: Buffer[] = [];

    const maxDuration = Math.min(meta.duration || 3, 3);
    // ВАЖНО: Telegram требует квадратные стикеры (100x100) для статических PNG
    // Для WEBM можно попробовать 100x110, но лучше оставить 100x100 для совместимости
    const targetWidth = 100;
    const targetHeight = 100;
    const targetFps = 30;
    const frameCount = Math.max(1, Math.floor(targetFps * maxDuration));
    const normalizedDuration = frameCount / targetFps;
    const tileCount = rows * cols;

    const splitLabels = Array.from({ length: tileCount }, (_, i) => `[s${i}]`);
    const outputLabels = Array.from({ length: tileCount }, (_, i) => `[out${i}]`);

    const baseFilterParts = [`fps=${targetFps}`, `trim=duration=${normalizedDuration}`, 'setpts=PTS-STARTPTS', 'format=rgba'];
    const baseFilter = `[0:v]${baseFilterParts.join(',')},split=${tileCount}${splitLabels.join('')}`;

    const tileFilters: string[] = [];
    const outputPaths: string[] = [];

    // ВАЖНО: Порядок должен быть row-first (сначала все тайлы первой строки, потом второй и т.д.)
    // Это соответствует порядку в Telegram эмодзи-паках
    // index = row * cols + col, где row = Math.floor(index / cols), col = index % cols
    for (let index = 0; index < tileCount; index++) {
      const y = Math.floor(index / cols); // row
      const x = index % cols; // col
      const offsetX = columnOffsets[x] ?? 0;
      const offsetY = rowOffsets[y] ?? 0;
      const tileWidth = columnWidths[x] ?? baseTileWidth;
      const tileHeight = rowHeights[y] ?? baseTileHeight;

      tileFilters.push(
        `${splitLabels[index]}crop=${tileWidth}:${tileHeight}:${offsetX}:${offsetY},scale=${targetWidth}:${targetHeight}:flags=lanczos,setsar=1,format=yuva420p,fps=${targetFps},trim=end_frame=${frameCount},setpts=PTS-STARTPTS${outputLabels[index]}`
      );

      const tmpOutput = path.join('/tmp', `tile-${x}-${y}-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`);
      outputPaths.push(tmpOutput);
    }

    const filterComplex = [baseFilter, ...tileFilters];

    const command = ffmpeg(tmpInput).complexFilter(filterComplex);

    for (let index = 0; index < tileCount; index++) {
      command
        .output(outputPaths[index])
        .outputOptions([
          '-map', outputLabels[index],
          '-c:v libvpx-vp9',
          '-b:v 500k',
          '-an',
          `-r ${targetFps}`,
          `-frames:v ${frameCount}`,
          `-g ${frameCount}`,
          `-keyint_min ${frameCount}`,
          '-lag-in-frames 0',
          '-auto-alt-ref 0',
          '-deadline realtime',
          '-pix_fmt yuva420p',
          '-row-mt 1',
          '-tile-columns 0',
          '-frame-parallel 0',
          '-arnr-maxframes 0',
          '-arnr-strength 0',
          '-arnr-type 0',
        ]);
    }

    await new Promise<void>((resolve, reject) => {
      command.on('end', () => resolve()).on('error', (err) => reject(err)).run();
    });

    // ВАЖНО: Читаем файлы в том же порядке, в котором они были созданы (row-first)
    // Это гарантирует правильный порядок тайлов в итоговом массиве
    for (const outputPath of outputPaths) {
      const data = await fs.promises.readFile(outputPath);
      tiles.push(data);
    }

    const previewTiles: Buffer[] = [];
    for (let i = 0; i < Math.min(outputPaths.length, tileCount); i++) {
      const tilePath = outputPaths[i];
      const tmpFrame = path.join('/tmp', `frame-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tilePath)
          .frames(1)
          .output(tmpFrame)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      const data = await fs.promises.readFile(tmpFrame);
      previewTiles.push(data);
      await fs.promises.unlink(tmpFrame).catch(() => {});
    }

    const tileImages = await Promise.all(
      previewTiles.map((buf) =>
        processTransparentImage(buf)
          .resize(128, 128, {
            fit: 'cover',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .ensureAlpha()
          .png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            effort: 10,
            force: true,
          })
          .toBuffer()
      )
    );

    const perRow = Math.min(tileImages.length, cols);
    const rowsPreview = Math.ceil(tileImages.length / perRow);
    const tileWidthPreview = 128;
    const tileHeightPreview = 128;
    const mosaicWidth = perRow * tileWidthPreview;
    const mosaicHeight = rowsPreview * tileHeightPreview;

    const canvas = sharp({
      create: {
        width: mosaicWidth,
        height: mosaicHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    });

    const composites = tileImages.map((img, i) => ({
      input: img,
      left: (i % perRow) * tileWidthPreview,
      top: Math.floor(i / perRow) * tileHeightPreview,
    }));

    const preview = await canvas
      .composite(composites)
      .ensureAlpha()
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        effort: 10,
        force: true,
      })
      .toBuffer();

    await Promise.all(outputPaths.map((p) => fs.promises.unlink(p).catch(() => {})));

    return { tiles, preview };
  } finally {
    await fs.promises.unlink(tmpInput).catch(() => {});
  }
}
