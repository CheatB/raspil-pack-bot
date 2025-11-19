import sharp, { Sharp } from 'sharp';

const PNG_OPTIONS = {
  compressionLevel: 9 as const,
  adaptiveFiltering: true,
  effort: 10 as const,
};

export function processTransparentImage(buffer: Buffer): Sharp {
  return sharp(buffer, { failOn: 'none' }).ensureAlpha();
}

export async function ensurePngWithAlpha(buffer: Buffer): Promise<Buffer> {
  return processTransparentImage(buffer).png(PNG_OPTIONS).toBuffer();
}
