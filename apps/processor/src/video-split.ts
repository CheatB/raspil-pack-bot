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
type SplitVideoToTilesOptions = {
  buildPreview?: boolean;
};

type TileDescriptor = {
  outputPath: string;
  offsetX: number;
  offsetY: number;
  tileWidth: number;
  tileHeight: number;
};

export async function splitVideoToTiles(
  buffer: Buffer,
  rows: number,
  cols: number,
  inputExt?: string,
  options?: SplitVideoToTilesOptions
): Promise<{ tiles: Buffer[]; preview?: Buffer }> {
  ensureFfmpegReady();

  // Определяем расширение для временного файла (для GIF используем 'gif', иначе 'mp4')
  const ext = inputExt || 'mp4';
  const tmpInput = path.join('/tmp', `input-${Date.now()}.${ext}`);
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
    const targetWidth = 100;
    const targetHeight = 100;
    const targetFps = 24;
    const frameCount = Math.max(1, Math.floor(targetFps * maxDuration));
    const normalizedDuration = frameCount / targetFps;
    const tileCount = rows * cols;

    const baseFilterParts = [`fps=${targetFps}`, `trim=duration=${normalizedDuration}`, 'setpts=PTS-STARTPTS', 'format=rgba'];
    const tileDescriptors: TileDescriptor[] = [];

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

      const tmpOutput = path.join('/tmp', `tile-${x}-${y}-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`);
      tileDescriptors.push({
        outputPath: tmpOutput,
        offsetX,
        offsetY,
        tileWidth,
        tileHeight,
      });
    }

    const tilesPerBatch =
      tileCount >= 49 ? 6 :
      tileCount >= 36 ? 8 :
      tileCount >= 25 ? 10 :
      tileCount >= 16 ? 12 :
      tileCount;

    const runBatch = async (batch: TileDescriptor[]) => {
      if (!batch.length) return;

      const splitLabels = Array.from({ length: batch.length }, (_, i) => `[s${i}]`);
      const outputLabels = Array.from({ length: batch.length }, (_, i) => `[out${i}]`);
      const baseFilter = `[0:v]${baseFilterParts.join(',')},split=${batch.length}${splitLabels.join('')}`;
      const tileFilters = batch.map((descriptor, idx) => (
        `${splitLabels[idx]}crop=${descriptor.tileWidth}:${descriptor.tileHeight}:${descriptor.offsetX}:${descriptor.offsetY},scale=${targetWidth}:${targetHeight}:flags=lanczos,setsar=1,format=yuva420p,fps=${targetFps},trim=end_frame=${frameCount},setpts=PTS-STARTPTS${outputLabels[idx]}`
      ));

      const command = ffmpeg(tmpInput).complexFilter([baseFilter, ...tileFilters]);

      batch.forEach((descriptor, idx) => {
        command
          .output(descriptor.outputPath)
          .outputOptions([
            '-map', outputLabels[idx],
            '-c:v libvpx-vp9',
            '-b:v 400k',
            '-an',
            `-r ${targetFps}`,
            `-frames:v ${frameCount}`,
            `-g ${frameCount}`,
            `-keyint_min ${frameCount}`,
            '-lag-in-frames 0',
            '-auto-alt-ref 0',
            '-deadline realtime',
            '-cpu-used 6',
            '-pix_fmt yuva420p',
            '-row-mt 1',
            '-tile-columns 0',
            '-frame-parallel 0',
            '-arnr-maxframes 0',
            '-arnr-strength 0',
            '-arnr-type 0',
          ]);
      });

      await new Promise<void>((resolve, reject) => {
        let isResolved = false;
        let killed = false;
        const timeoutMs = Math.min(180000, 60000 + batch.length * 7000);
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            killed = true;
            try {
              command.kill('SIGTERM');
              setTimeout(() => {
                try {
                  command.kill('SIGKILL');
                } catch (e) {
                  // ignore
                }
              }, 3000);
            } catch (e) {
              // ignore
            }
            reject(new Error('FFmpeg timeout while splitting видео на тайлы'));
          }
        }, timeoutMs);

        const handleProcessError = (err: any) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeout);
            if (err?.message?.includes('SIGKILL')) {
              reject(new Error('FFmpeg был убит системой (возможно нехватка памяти). Попробуйте уменьшить сетку или укоротить видео.'));
            } else {
              reject(err);
            }
          }
        };

        command
          .on('end', () => {
            if (!isResolved && !killed) {
              isResolved = true;
              clearTimeout(timeout);
              resolve();
            }
          })
          .on('error', handleProcessError)
          .on('stderr', (stderrLine) => {
            if (stderrLine.includes('error') || stderrLine.includes('Error') || stderrLine.includes('Killed')) {
              console.error('[video-split] FFmpeg stderr:', stderrLine);
            }
          })
          .run();
      });
    };

    for (let i = 0; i < tileDescriptors.length; i += tilesPerBatch) {
      const batch = tileDescriptors.slice(i, i + tilesPerBatch);
      await runBatch(batch);
    }

    // ВАЖНО: Читаем файлы в том же порядке, в котором они были созданы (row-first)
    // Это гарантирует правильный порядок тайлов в итоговом массиве
    for (const descriptor of tileDescriptors) {
      const data = await fs.promises.readFile(descriptor.outputPath);
      tiles.push(data);
    }

    const shouldBuildPreview = options?.buildPreview ?? false;
    let preview: Buffer | undefined;

    if (shouldBuildPreview) {
      const previewTiles: Buffer[] = [];
      for (let i = 0; i < Math.min(tileDescriptors.length, tileCount); i++) {
        const tilePath = tileDescriptors[i].outputPath;
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

      preview = await canvas
        .composite(composites)
        .ensureAlpha()
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          effort: 10,
          force: true,
        })
        .toBuffer();
    }

    await Promise.all(tileDescriptors.map((descriptor) => fs.promises.unlink(descriptor.outputPath).catch(() => {})));

    return { tiles, preview };
  } finally {
    await fs.promises.unlink(tmpInput).catch(() => {});
  }
}
