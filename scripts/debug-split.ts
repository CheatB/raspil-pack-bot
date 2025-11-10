import fs from 'fs';
import path from 'path';

import { splitVideoToTiles } from '../apps/processor/src/video-split';

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: pnpm ts-node scripts/debug-split.ts <video-file>');
    process.exit(1);
  }

  const buffer = await fs.promises.readFile(inputPath);
  const outputDir = path.resolve(process.cwd(), 'debug-tiles');
  await fs.promises.mkdir(outputDir, { recursive: true });

  const { tiles } = await splitVideoToTiles(buffer, 3, 3);

  await Promise.all(
    tiles.map(async (tile, index) => {
      const outPath = path.join(outputDir, `tile-${index + 1}.webm`);
      await fs.promises.writeFile(outPath, tile);
      console.log('Saved', outPath);
    })
  );

  console.log('Total tiles:', tiles.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
