import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

function serializePack(pack: any) {
  return {
    ...pack,
    userId: pack.userId ? Number(pack.userId) : null,
    createdAt: pack.createdAt?.toISOString?.() ?? pack.createdAt,
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userIdParam = searchParams.get('userId');
  const userId = userIdParam ? Number(userIdParam) : null;

  if (!userId) {
    return NextResponse.json({ error: 'No userId' }, { status: 400 });
  }

  const packs = await prisma.pack.findMany({
    where: { userId: BigInt(userId) },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const items = packs.map(serializePack);

  return NextResponse.json({ items });
}

