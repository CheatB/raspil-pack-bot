import { logger } from '@/lib/logger';
import { initBot, handleUpdate } from '@/lib/bot-handler';

// Lazy get env to avoid loading before Next.js loads .env.local
// Next.js automatically loads .env.local from project root
function getEnv() {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('WEBHOOK_SECRET is not set in environment variables');
  }
  return {
    WEBHOOK_SECRET: secret,
  };
}

// Initialize bot lazily on first request
let botInitialized = false;
function ensureBotInitialized() {
  if (!botInitialized) {
    initBot();
    botInitialized = true;
  }
}

export async function POST(req: Request) {
  try {
    // Initialize bot on first request (env vars are loaded by this point)
    ensureBotInitialized();

    const env = getEnv();
    const providedSecretRaw =
      req.headers.get('x-telegram-bot-api-secret-token') ||
      req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    const providedSecret = providedSecretRaw?.trim();
    const expectedSecret = env.WEBHOOK_SECRET.trim();
    if (providedSecret !== expectedSecret) {
      logger.warn(
        {
          provided: providedSecretRaw
            ? `${providedSecretRaw.slice(0, 4)}...${providedSecretRaw.slice(-4)}`
            : null,
          expected: `${env.WEBHOOK_SECRET.slice(0, 4)}...${env.WEBHOOK_SECRET.slice(-4)}`,
          providedLength: providedSecretRaw?.length ?? null,
          expectedLength: env.WEBHOOK_SECRET.length,
        },
        'Webhook request rejected: invalid secret token'
      );
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    
    // Логируем тип обновления для отладки
    const updateType = body.message ? 'message' : 
                      body.callback_query ? 'callback_query' : 
                      body.edited_message ? 'edited_message' : 'unknown';
    
    logger.info({ 
      updateId: body.update_id, 
      updateType,
      messageText: body.message?.text,
      messageCommand: body.message?.entities?.[0]?.type === 'bot_command' ? body.message.text : undefined,
    }, 'Processing update');
    
    await handleUpdate(body);

    return Response.json({ ok: true });
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      message: error.message 
    }, 'Webhook error');
    return Response.json({ 
      error: 'Internal error',
      message: error.message 
    }, { status: 500 });
  }
}
