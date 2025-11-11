import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userCount = await prisma.user.count();
    return Response.json({ ok: true, userCount });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        error: error?.message || 'Unknown error',
        stack: error?.stack,
      },
      { status: 500 }
    );
  }
}

