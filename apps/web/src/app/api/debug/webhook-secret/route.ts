export const runtime = 'nodejs';

export async function GET() {
  const secret = process.env.WEBHOOK_SECRET;
  return Response.json({
    hasSecret: Boolean(secret),
    secretPreview: secret ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : null,
  });
}

