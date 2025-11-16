import sharp from 'sharp';

export interface GridSize {
  rows: number;
  cols: number;
  tilesCount: number;
}

/**
 * Generate ranked grid options based on media orientation.
 */
export function suggestGridOptions(
  width: number,
  height: number,
  limit: number = 3,
  maxDimension: number = 8
): GridSize[] {
  const aspectRatio = width / Math.max(height, 1);
  const candidates: Array<GridSize & { score: number }> = [];

  const MIN_ROWS = 1;
  const MIN_COLS = 1;
  const MAX_SIZE = Math.max(2, Math.min(maxDimension, 15));

  for (let rows = MIN_ROWS; rows <= MAX_SIZE; rows++) {
    for (let cols = MIN_COLS; cols <= MAX_SIZE; cols++) {
      const tilesCount = rows * cols;

      // Skip trivial or overly large grids
      if (tilesCount < 2 || tilesCount > 36) continue;

      // Вычисляем соотношение сторон мозаики (сетки)
      const mosaicAspect = cols / Math.max(rows, 1);
      const aspectDeviation = Math.abs(mosaicAspect - aspectRatio);

      // КРИТИЧНО: Вычисляем соотношение сторон исходного тайла (до ресайза в 100×110)
      // Это важно, так как конечные эмодзи имеют размер 100×110 (вытянуты по вертикали для компенсации сплющивания в Telegram)
      // Нужно чтобы исходные тайлы были максимально квадратными
      const sourceTileWidth = width / Math.max(cols, 1);
      const sourceTileHeight = height / Math.max(rows, 1);
      const sourceTileAspect = sourceTileWidth / Math.max(sourceTileHeight, 1);
      const squareDeviation = Math.abs(sourceTileAspect - 1); // Отклонение от квадрата

      const targetTiles = aspectRatio > 1.5 || aspectRatio < 0.67 ? 6 : 9;
      const tileCountPenalty = Math.abs(tilesCount - targetTiles) / targetTiles;

      // Увеличиваем вес squareDeviation до 0.7, так как квадратные тайлы критичны
      // aspectDeviation снижаем до 0.2, так как мозаика может не совпадать с исходным изображением
      // tileCountPenalty оставляем 0.1
      const score = aspectDeviation * 0.2 + squareDeviation * 0.7 + tileCountPenalty * 0.1;

      candidates.push({
        rows,
        cols,
        tilesCount,
        score,
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    if (a.tilesCount !== b.tilesCount) {
      return a.tilesCount - b.tilesCount;
    }
    return a.rows - b.rows;
  });

  const seen = new Set<string>();
  const result: GridSize[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.rows}x${candidate.cols}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      rows: candidate.rows,
      cols: candidate.cols,
      tilesCount: candidate.tilesCount,
    });
    if (result.length >= limit) break;
  }

  if (!result.length) {
    result.push({ rows: 3, cols: 3, tilesCount: 9 });
  }

  return result;
}

/**
 * Auto-select grid dimensions for preview (9-15 tiles)
 * Tries to keep tiles close to square aspect ratio
 */
export function autoGridForPreview(
  width: number,
  height: number
): GridSize {
  const [primary] = suggestGridOptions(width, height, 1);
  return primary ?? { rows: 3, cols: 3, tilesCount: 9 };
}

/**
 * Build mosaic preview from input image
 * @param inputBuffer - Source image buffer
 * @param rows - Number of rows in grid
 * @param cols - Number of columns in grid
 * @param padding - Padding between tiles in pixels (0-6, step 2)
 * @returns Buffer with PNG mosaic preview
 */
export async function buildMosaicPreview(
  inputBuffer: Buffer,
  rows: number,
  cols: number,
  padding: number = 2
): Promise<Buffer> {
  try {
    // Clamp padding to valid range (0-6, step 2)
    padding = Math.max(0, Math.min(6, Math.round(padding / 2) * 2));

    // Load image and get metadata
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    
    if (!metadata.width || !metadata.height) {
      throw new Error(`Invalid image metadata: width=${metadata.width}, height=${metadata.height}`);
    }
    
    const width = metadata.width;
    const height = metadata.height;

  // Вычисляем доступную область с учетом padding
  const availableWidth = width - padding * (cols - 1);
  const availableHeight = height - padding * (rows - 1);
  
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
  const columnOffsets = columnWidths.reduce<number[]>((acc, _width, idx) => {
    acc.push((acc[idx - 1] ?? 0) + (idx === 0 ? 0 : columnWidths[idx - 1]));
    return acc;
  }, []);
  
  const rowOffsets = rowHeights.reduce<number[]>((acc, _height, idx) => {
    acc.push((acc[idx - 1] ?? 0) + (idx === 0 ? 0 : rowHeights[idx - 1]));
    return acc;
  }, []);

  // Calculate canvas size (с учетом реальных размеров тайлов)
  const canvasWidth = columnWidths.reduce((sum, w) => sum + w, 0) + padding * (cols - 1);
  const canvasHeight = rowHeights.reduce((sum, h) => sum + h, 0) + padding * (rows - 1);

    // Extract tiles
    const tiles: Buffer[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const offsetX = columnOffsets[col] ?? 0;
        const offsetY = rowOffsets[row] ?? 0;
        const tileWidth = columnWidths[col] ?? baseTileWidth;
        const tileHeight = rowHeights[row] ?? baseTileHeight;
        
        // Добавляем padding к смещению
        const left = offsetX + col * padding;
        const top = offsetY + row * padding;

        const extractLeft = Math.max(0, Math.min(left, width - 1));
        const extractTop = Math.max(0, Math.min(top, height - 1));
        const extractWidth = Math.max(1, Math.min(tileWidth, width - extractLeft));
        const extractHeight = Math.max(1, Math.min(tileHeight, height - extractTop));

        try {
          const tile = await image
            .clone()
            .extract({
              left: extractLeft,
              top: extractTop,
              width: extractWidth,
              height: extractHeight,
            })
            .resize(tileWidth, tileHeight, {
              fit: 'contain', // Сохраняем пропорции
              background: { r: 0, g: 0, b: 0, alpha: 0 }, // Прозрачный фон
            })
            .toBuffer();

          tiles.push(tile);
        } catch (extractError: any) {
          console.error(`Error extracting tile [${row}, ${col}]:`, extractError);
          throw new Error(`Failed to extract tile at row ${row}, col ${col}: ${extractError.message}`);
        }
      }
    }

    // Create canvas with transparent background
    const canvas = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }, // Transparent
      },
    });

    // Composite tiles onto canvas
    const composites = tiles.map((tile, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      
      // Вычисляем смещение с учетом реальных размеров тайлов
      let left = 0;
      for (let i = 0; i < col; i++) {
        left += columnWidths[i] + padding;
      }
      
      let top = 0;
      for (let i = 0; i < row; i++) {
        top += rowHeights[i] + padding;
      }

      return {
        input: tile,
        left,
        top,
      };
    });

    let preview = await canvas.composite(composites).png().toBuffer();

    // Добавляем линии сетки для визуализации (только для отображения, не влияют на обработку)
    // Создаем линии поверх превью
    const gridLines: Array<{ input: Buffer; left: number; top: number }> = [];
    
    // Вертикальные линии между колонками
    for (let col = 1; col < cols; col++) {
      let lineX = 0;
      for (let i = 0; i < col; i++) {
        lineX += columnWidths[i] + padding;
      }
      
      // Создаем вертикальную линию (1px ширина, высота всего canvas)
      const verticalLine = sharp({
        create: {
          width: 2, // 2px для лучшей видимости
          height: canvasHeight,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0.8 }, // Красная линия с прозрачностью
        },
      });
      
      const lineBuffer = await verticalLine.png().toBuffer();
      gridLines.push({
        input: lineBuffer,
        left: lineX - 1, // Центрируем линию на границе
        top: 0,
      });
    }
    
    // Горизонтальные линии между строками
    for (let row = 1; row < rows; row++) {
      let lineY = 0;
      for (let i = 0; i < row; i++) {
        lineY += rowHeights[i] + padding;
      }
      
      // Создаем горизонтальную линию (ширина всего canvas, 1px высота)
      const horizontalLine = sharp({
        create: {
          width: canvasWidth,
          height: 2, // 2px для лучшей видимости
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0.8 }, // Красная линия с прозрачностью
        },
      });
      
      const lineBuffer = await horizontalLine.png().toBuffer();
      gridLines.push({
        input: lineBuffer,
        left: 0,
        top: lineY - 1, // Центрируем линию на границе
      });
    }
    
    // Накладываем линии поверх превью
    if (gridLines.length > 0) {
      const previewWithGrid = sharp(preview);
      preview = await previewWithGrid.composite(gridLines).png().toBuffer();
    }

    return preview;
  } catch (error: any) {
    console.error('buildMosaicPreview error:', error);
    throw new Error(`Failed to build mosaic preview: ${error.message || 'Unknown error'}`);
  }
}

