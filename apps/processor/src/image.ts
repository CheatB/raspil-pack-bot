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

      const mosaicAspect = cols / Math.max(rows, 1);
      const aspectDeviation = Math.abs(mosaicAspect - aspectRatio);

      const tileAspect = (width / Math.max(cols, 1)) / (height / Math.max(rows, 1));
      const squareDeviation = Math.abs(tileAspect - 1);

      const targetTiles = aspectRatio > 1.5 || aspectRatio < 0.67 ? 6 : 9;
      const tileCountPenalty = Math.abs(tilesCount - targetTiles) / targetTiles;

      const score = aspectDeviation * 0.6 + squareDeviation * 0.3 + tileCountPenalty * 0.1;

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

  // Calculate tile dimensions
  const tileWidth = Math.floor((width - padding * (cols - 1)) / cols);
  const tileHeight = Math.floor((height - padding * (rows - 1)) / rows);

  // Calculate canvas size
  const canvasWidth = cols * tileWidth + padding * (cols - 1);
  const canvasHeight = rows * tileHeight + padding * (rows - 1);

    // Extract tiles
    const tiles: Buffer[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * (tileWidth + padding);
        const top = row * (tileHeight + padding);

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
              fit: 'fill',
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
      const left = col * (tileWidth + padding);
      const top = row * (tileHeight + padding);

      return {
        input: tile,
        left,
        top,
      };
    });

    const preview = await canvas.composite(composites).png().toBuffer();

    return preview;
  } catch (error: any) {
    console.error('buildMosaicPreview error:', error);
    throw new Error(`Failed to build mosaic preview: ${error.message || 'Unknown error'}`);
  }
}

