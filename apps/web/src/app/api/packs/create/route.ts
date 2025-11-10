export const runtime = 'nodejs';

import { enqueuePackJob } from '@/lib/queue';
import { userHasPro } from '@/lib/subscription';

export async function POST(req: Request) {
  try {
    const key = req.headers.get('x-internal-key');
    if (key !== process.env.INTERNAL_KEY) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const {
      fileUrl,
      userId,
      removeBranding = false,
      gridRows,
      gridCols,
      padding,
      mediaType,
    } = body ?? {};

    if (!fileUrl || !userId) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const userIdNum = Number(userId);
    if (!Number.isFinite(userIdNum)) {
      return Response.json({ error: 'Invalid userId' }, { status: 400 });
    }

    const isPro = await userHasPro(userIdNum);
    const shouldRemoveBranding = isPro ? true : Boolean(removeBranding);

    const rows = Math.max(1, Number(gridRows) || 3);
    const cols = Math.max(1, Number(gridCols) || 3);
    const pad = Math.max(0, Number.isFinite(Number(padding)) ? Number(padding) : 2);
    const normalizedMediaType = mediaType === 'image' ? 'image' : 'video';

    const result = await enqueuePackJob({
      fileUrl,
      userId: userIdNum,
      removeBranding: shouldRemoveBranding,
      gridRows: rows,
      gridCols: cols,
      padding: pad,
      mediaType: normalizedMediaType,
    });

    return Response.json({
      ok: true,
      message: 'Пак поставлен в очередь',
      jobId: result.jobId,
    });
  } catch (error) {
    console.error('packs/create unexpected error:', error);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

