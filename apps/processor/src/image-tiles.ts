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
  const tileWidth = Math.max(1, Math.floor((width - normalizedPadding * (cols - 1)) / cols));
  const tileHeight = Math.max(1, Math.floor((height - normalizedPadding * (rows - 1)) / rows));

  const tiles: Buffer[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = col * (tileWidth + normalizedPadding);
      const top = row * (tileHeight + normalizedPadding);

      const extractLeft = clamp(left, 0, Math.max(0, width - 1));
      const extractTop = clamp(top, 0, Math.max(0, height - 1));
      const extractWidth = clamp(tileWidth, 1, width - extractLeft);
      const extractHeight = clamp(tileHeight, 1, height - extractTop);

      const tileBuffer = await image
        .clone()
        .extract({
          left: extractLeft,
          top: extractTop,
          width: extractWidth,
          height: extractHeight,
        })
        .resize(100, 100, {
          fit: 'fill',
        })
        .toBuffer();

      const pngTile = await sharp(tileBuffer)
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: true,
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
