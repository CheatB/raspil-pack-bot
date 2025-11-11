import fs from 'fs';
import path from 'path';

let ensured = false;

export function ensureSqliteDatabase() {
  if (ensured) {
    return;
  }
  ensured = true;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.startsWith('file:')) {
    return;
  }

  try {
    const dbPath = dbUrl.replace('file:', '');
    if (!dbPath.startsWith('/tmp')) {
      return;
    }

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(dbPath)) {
      const candidates = [
        path.join(process.cwd(), 'prisma', 'dev.db'),
        path.join(process.cwd(), '..', 'prisma', 'dev.db'),
        path.join(process.cwd(), '..', '..', 'prisma', 'dev.db'),
        path.join(process.cwd(), '..', '..', '..', 'prisma', 'dev.db'),
      ];

      const seedPath = candidates.find((candidate) => fs.existsSync(candidate));

      if (seedPath) {
        fs.copyFileSync(seedPath, dbPath);
      } else {
        fs.writeFileSync(dbPath, '');
      }
    }
  } catch (error) {
    console.error('Failed to ensure SQLite database', error);
  }
}

