import sharp from 'sharp';
import { generatePreview } from '@repo/processor';

describe('Image transparency pipeline', () => {
  async function createTransparentCirclePng(): Promise<Buffer> {
    const svgCircle = `
      <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <circle cx="256" cy="256" r="150" fill="#ff0000" />
      </svg>
    `;

    return sharp(Buffer.from(svgCircle))
      .png({ compressionLevel: 0 })
      .toBuffer();
  }

  it('preserves alpha channel for preview and tiles', async () => {
    const buffer = await createTransparentCirclePng();
    const { preview, tiles } = await generatePreview({
      buffer,
      rows: 3,
      cols: 3,
      padding: 2,
    });

    expect(tiles).toHaveLength(9);

    const previewMetadata = await sharp(preview).metadata();
    expect(previewMetadata.format).toBe('png');
    expect(previewMetadata.hasAlpha).toBe(true);

    const previewRaw = await sharp(preview)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(previewRaw.data[3]).toBe(0);

    for (const tile of tiles) {
      const metadata = await sharp(tile).metadata();
      expect(['png', 'webp']).toContain(metadata.format);
    }

    const firstTileMetadata = await sharp(tiles[0]).metadata();
    expect(firstTileMetadata.hasAlpha).toBe(true);

    const firstTileRaw = await sharp(tiles[0])
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(firstTileRaw.data[3]).toBe(0);
  });
});
