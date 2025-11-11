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
      const seedPath = path.join(process.cwd(), 'prisma', 'dev.db');
      if (fs.existsSync(seedPath)) {
        fs.copyFileSync(seedPath, dbPath);
      } else {
        fs.writeFileSync(dbPath, '');
      }
    }
  } catch (error) {
    console.error('Failed to ensure SQLite database', error);
  }
}

