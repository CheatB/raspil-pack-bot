import { logger } from '@/lib/logger';
import { checkAndIncImageQuota } from '@/lib/quota';
import { autoGridForPreview, buildMosaicPreview, suggestGridOptions } from '@repo/processor';
import axios from 'axios';
import sharp from 'sharp';

// Ленивый импорт видео функций (только при необходимости)
let videoModule: typeof import('@repo/processor') | null = null;

async function getVideoModule() {
  if (!videoModule) {
    videoModule = await import('@repo/processor');
  }
  return videoModule;
}

// Lazy get env to avoid loading issues
function getEnv() {
  const internalKey = process.env.INTERNAL_KEY;
  if (!internalKey) {
    throw new Error('INTERNAL_KEY is not set in environment variables');
  }
  return {
    INTERNAL_KEY: internalKey,
  };
}

// Verify internal key
function verifyInternalKey(req: Request): boolean {
  const env = getEnv();
  const key = req.headers.get('x-internal-key');
  return key === env.INTERNAL_KEY;
}

export async function POST(req: Request) {
  try {
    // Verify internal key
    if (!verifyInternalKey(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      userId,
      fileUrl,
      width,
      height,
      padding = 2,
      skipQuota = false,
      fileType,
      username,
      gridRows,
      gridCols,
    } = body;

    if (!userId || !fileUrl) {
      return Response.json(
        { error: 'Missing required fields: userId, fileUrl' },
        { status: 400 }
      );
    }

    const userIdBigInt = BigInt(userId);

    const GRID_MIN = 1;
    const GRID_MAX = 15;

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    const requestedRows = Number(gridRows);
    const requestedCols = Number(gridCols);
    const hasCustomGrid = Number.isFinite(requestedRows) && Number.isFinite(requestedCols) && requestedRows > 0 && requestedCols > 0;

    const normalizedPadding = clamp(Number(padding) || 0, 0, 12);

    // Check and increment quota ONLY if skipQuota is false
    // This allows users to adjust padding without consuming additional quota
    if (!skipQuota) {
      try {
        await checkAndIncImageQuota(userIdBigInt, username);
      } catch (error: any) {
        if (error.message.includes('Лимит')) {
          return Response.json(
            { error: error.message },
            { status: 429 }
          );
        }
        throw error;
      }
    } else {
      logger.info({ userId: userIdBigInt, padding }, 'Skipping quota check for padding update');
    }

    // Download file
    logger.info({ userId: userIdBigInt, fileUrl }, 'Processing preview');
    let buffer: Buffer;
    try {
      const fileResponse = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000, // 30 секунд таймаут для загрузки файла
      });
      buffer = Buffer.from(fileResponse.data);
      logger.info({ userId: userIdBigInt, bufferSize: buffer.length }, 'File downloaded');
    } catch (downloadError: any) {
      logger.error({ err: downloadError, userId: userIdBigInt, fileUrl }, 'File download failed');
      return Response.json(
        { error: `Ошибка при загрузке файла: ${downloadError.message || 'Неизвестная ошибка'}` },
        { status: 500 }
      );
    }

    // Определяем тип файла по расширению URL или переданному типу
    const ext = fileUrl.split('.').pop()?.toLowerCase() || '';
    // Поддерживаем видео и GIF (только если явно указан тип или расширение видео/GIF)
    // Для изображений fileType будет 'image' или undefined, так что они не попадут в isVideo
    const videoExts = ['mp4', 'mov', 'webm', 'mkv'];
    const isVideo = videoExts.includes(ext) || 
                    fileType === 'video';
    const isGif = ext === 'gif' || fileType === 'animation' || fileType === 'gif';
    const needsVideoProcessing = isVideo || isGif;
    
    logger.info({ userId: userIdBigInt, ext, fileType, isVideo, isGif, needsVideoProcessing }, 'File type detection');

    if (needsVideoProcessing) {
      try {
        logger.info({ userId: userIdBigInt, ext, fileType }, 'Detected video/GIF file, extracting first frame');
        
        // Ленивый импорт видео модуля
        const videoModule = await getVideoModule();
        const { getVideoMeta, extractFirstFrame } = videoModule as any;

        // Определяем расширение для обработки (для GIF используем 'gif', иначе 'mp4')
        const videoExt = isGif ? 'gif' : (ext || 'mp4');
        
        // Проверяем метаданные видео
        const { duration, sizeMB, width: videoWidth = 512, height: videoHeight = 512 } = await getVideoMeta(buffer, videoExt);

        logger.info({ userId: userIdBigInt, duration, sizeMB }, 'Video metadata retrieved');
        
        if (duration > 3) {
          logger.warn({ userId: userIdBigInt, duration }, 'Video too long');
          return Response.json(
            { error: 'Видео длиннее 3 секунд' },
            { status: 400 }
          );
        }
        
        if (sizeMB > 10) {
          logger.warn({ userId: userIdBigInt, sizeMB }, 'Video too large');
          return Response.json(
            { error: 'Файл больше 10 МБ' },
            { status: 400 }
          );
        }

        const suggestedGrids = suggestGridOptions(videoWidth, videoHeight, 4)
          .filter((option) => option.rows <= GRID_MAX && option.cols <= GRID_MAX);

        let grid = hasCustomGrid
          ? {
              rows: clamp(Math.round(requestedRows), GRID_MIN, GRID_MAX),
              cols: clamp(Math.round(requestedCols), GRID_MIN, GRID_MAX),
            }
          : (suggestedGrids[0] ?? autoGridForPreview(videoWidth, videoHeight));

        if (!grid || !Number.isFinite(grid.rows) || !Number.isFinite(grid.cols)) {
          grid = { rows: 3, cols: 3 };
        }

        const normalizedGrid = {
          rows: clamp(Math.round(grid.rows), GRID_MIN, GRID_MAX),
          cols: clamp(Math.round(grid.cols), GRID_MIN, GRID_MAX),
        };

        // Если сетка кастомная, не добавляем ее в gridOptions, чтобы она не отображалась как предложенная
        const combinedOptions = hasCustomGrid
          ? [...suggestedGrids] // Для кастомной сетки используем только предложенные варианты
          : [
              { rows: normalizedGrid.rows, cols: normalizedGrid.cols, tilesCount: normalizedGrid.rows * normalizedGrid.cols },
              ...suggestedGrids,
            ];

        const uniqueOptions: Array<{ rows: number; cols: number; tilesCount: number }> = [];
        const seen = new Set<string>();
        for (const option of combinedOptions) {
          const key = `${option.rows}x${option.cols}`;
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueOptions.push({
            rows: option.rows,
            cols: option.cols,
            tilesCount: option.tilesCount ?? option.rows * option.cols,
          });
          if (uniqueOptions.length >= 4) break;
        }

        if (!extractFirstFrame) {
          throw new Error('extractFirstFrame is not available');
        }

        const frameBuffer: Buffer = await extractFirstFrame(buffer, videoExt);
        const previewBuffer = await buildMosaicPreview(
          frameBuffer,
          normalizedGrid.rows,
          normalizedGrid.cols,
          normalizedPadding
        );
        const base64 = previewBuffer.toString('base64');

        return Response.json({
          previewDataUrl: `data:image/png;base64,${base64}`,
          suggestedGrid: normalizedGrid,
          tilesCount: normalizedGrid.rows * normalizedGrid.cols,
          gridOptions: uniqueOptions,
          isVideo: true,
        });
      } catch (videoError: any) {
        logger.error({ 
          err: videoError, 
          stack: videoError?.stack,
          message: videoError?.message,
          userId: userIdBigInt,
          ext,
          fileType 
        }, 'Video processing error');
        
        // Более понятные сообщения об ошибках
        let errorMessage = 'Ошибка при обработке видео/GIF';
        if (videoError?.message?.includes('FFmpeg is not available')) {
          errorMessage = 'FFmpeg не доступен. Обработка видео/GIF временно недоступна.';
        } else if (videoError?.message) {
          errorMessage = `Ошибка при обработке: ${videoError.message}`;
        }
        
        return Response.json({ error: errorMessage }, { status: 500 });
      }
    }

    const imageBuffer = buffer;
    logger.info({ userId: userIdBigInt, ext }, 'Processing as image');

    // Get image dimensions if not provided
    let imageWidth = width;
    let imageHeight = height;

    try {
      if (!imageWidth || !imageHeight) {
        const metadata = await sharp(imageBuffer).metadata();
        imageWidth = metadata.width || 512;
        imageHeight = metadata.height || 512;
        logger.debug({ userId: userIdBigInt, imageWidth, imageHeight }, 'Image dimensions');
      }
    } catch (sharpError: any) {
      logger.error({ err: sharpError, userId: userIdBigInt }, 'Sharp metadata error');
      return Response.json(
        { error: `Ошибка при чтении изображения: ${sharpError.message || 'Неизвестная ошибка'}` },
        { status: 500 }
      );
    }

    // Для изображений создаем мозаику
    const suggestedGrids = suggestGridOptions(imageWidth, imageHeight, 4)
      .filter((option) => option.rows <= GRID_MAX && option.cols <= GRID_MAX);

    let grid = hasCustomGrid
      ? {
          rows: clamp(Math.round(requestedRows), GRID_MIN, GRID_MAX),
          cols: clamp(Math.round(requestedCols), GRID_MIN, GRID_MAX),
        }
      : (suggestedGrids[0] ?? autoGridForPreview(imageWidth, imageHeight));
    
    logger.info({ 
      userId: userIdBigInt, 
      hasCustomGrid, 
      requestedRows, 
      requestedCols, 
      grid: `${grid.rows}x${grid.cols}` 
    }, 'Grid selection for preview');

    if (!grid || !Number.isFinite(grid.rows) || !Number.isFinite(grid.cols)) {
      grid = { rows: 3, cols: 3 };
    }

    const normalizedGrid = {
      rows: clamp(Math.round(grid.rows), GRID_MIN, GRID_MAX),
      cols: clamp(Math.round(grid.cols), GRID_MIN, GRID_MAX),
    };

    // Если сетка кастомная, не добавляем ее в gridOptions, чтобы она не отображалась как предложенная
    const combinedOptions = hasCustomGrid
      ? [...suggestedGrids] // Для кастомной сетки используем только предложенные варианты
      : [
          { rows: normalizedGrid.rows, cols: normalizedGrid.cols, tilesCount: normalizedGrid.rows * normalizedGrid.cols },
          ...suggestedGrids,
        ];

    const uniqueOptions: Array<{ rows: number; cols: number; tilesCount: number }> = [];
    const seen = new Set<string>();
    for (const option of combinedOptions) {
      const key = `${option.rows}x${option.cols}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueOptions.push({
        rows: option.rows,
        cols: option.cols,
        tilesCount: option.tilesCount ?? option.rows * option.cols,
      });
      if (uniqueOptions.length >= 4) break;
    }

    try {
      // Build mosaic preview
      const previewBuffer = await buildMosaicPreview(
        imageBuffer,
        normalizedGrid.rows,
        normalizedGrid.cols,
        normalizedPadding
      );
      logger.debug({ userId: userIdBigInt }, 'Mosaic preview built');

      // Convert to base64 data URL
      const previewDataUrl = `data:image/png;base64,${previewBuffer.toString('base64')}`;

      logger.info({ userId: userIdBigInt, grid: `${normalizedGrid.rows}x${normalizedGrid.cols}`, tiles: normalizedGrid.rows * normalizedGrid.cols }, 'Preview generated');

      return Response.json({
        previewDataUrl,
        suggestedGrid: {
          rows: normalizedGrid.rows,
          cols: normalizedGrid.cols,
        },
        tilesCount: normalizedGrid.rows * normalizedGrid.cols,
        gridOptions: uniqueOptions,
        isVideo: false,
      });
    } catch (mosaicError: any) {
      logger.error({ err: mosaicError, userId: userIdBigInt }, 'Mosaic generation error');
      return Response.json(
        { error: `Ошибка при создании мозаики: ${mosaicError.message || 'Неизвестная ошибка'}` },
        { status: 500 }
      );
    }
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      message: error.message 
    }, 'Preview processing error');
    return Response.json(
      {
        error: error.message || 'Internal server error',
      },
      { status: 500 }
    );
  }
}

