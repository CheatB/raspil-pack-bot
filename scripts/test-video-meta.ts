import { getVideoMeta, extractFirstFrame } from '../apps/processor/src/video';
import { splitVideoToTiles } from '../apps/processor/src/video-split';
import fs from 'fs';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: pnpm ts-node scripts/test-video-meta.ts <file>');
    process.exit(1);
  }
  const buffer = await fs.promises.readFile(inputPath);
  const meta = await getVideoMeta(buffer, 'mp4');
  console.log('Meta:', meta);
  const frame = await extractFirstFrame(buffer, 'mp4');
  console.log('First frame size:', frame.length);
  const { tiles } = await splitVideoToTiles(buffer, 3, 3);
  console.log('Tiles:', tiles.length, 'first size', tiles[0]?.length);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
