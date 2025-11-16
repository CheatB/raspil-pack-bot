import { logger } from '@/lib/logger';
import { initBot, handleUpdate } from '@/lib/bot-handler';

// Lazy get env to avoid loading before Next.js loads .env.local
// Next.js automatically loads .env.local from project root
function getEnv() {
  const secret = process.env.WEBHOOK_SECRET;
  logger.info({ 
    hasSecret: !!secret,
    secretLength: secret?.length ?? 0,
    secretPreview: secret ? `${secret.slice(0, 4)}...${secret.slice(-4)}` : 'none'
  }, 'WEBHOOK_SECRET check');
  if (!secret) {
    logger.error('WEBHOOK_SECRET is not set in environment variables');
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
    // Сначала проверяем секрет, чтобы не тратить ресурсы на инициализацию при неверном запросе
    let env;
    try {
      env = getEnv();
    } catch (envError: any) {
      logger.error({ err: envError }, 'Failed to get environment variables');
      return Response.json({ error: 'Configuration error' }, { status: 500 });
    }

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

    let body: any;
    try {
      body = await req.json();
    } catch (parseError: any) {
      logger.error({ err: parseError }, 'Failed to parse request body');
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }
    
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
    
    // Initialize bot on first request (env vars are loaded by this point)
    try {
      ensureBotInitialized();
    } catch (initError: any) {
      logger.error({ err: initError, updateId: body.update_id }, 'Failed to initialize bot');
      // Возвращаем 200, чтобы Telegram не считал запрос неудачным
      // Но логируем ошибку для отладки
      return Response.json({ ok: true, error: 'Bot initialization failed' });
    }
    
    // handleUpdate больше не пробрасывает ошибки наверх
    await handleUpdate(body);

    return Response.json({ ok: true });
  } catch (error: any) {
    logger.error({ 
      err: error, 
      stack: error.stack,
      message: error.message 
    }, 'Webhook error');
    // Всегда возвращаем 200, чтобы Telegram не считал запрос неудачным
    // Ошибки уже обработаны в handleUpdate и обработчиках команд
    return Response.json({ ok: true, error: 'Processed with errors' });
  }
}
