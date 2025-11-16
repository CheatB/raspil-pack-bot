import axios from 'axios';
import crypto from 'crypto';

const INTERNAL_KEY_HEADER = 'x-internal-key';
const T_BANK_INIT_URL = 'https://securepay.tinkoff.ru/v2/Init';

type Plan = 'pro';
type Term = '30d' | '365d';

const PLAN_PRICING: Record<Plan, Record<Term, number>> = {
  pro: {
    '30d': 299,
    '365d': 1990,
  },
};

function serializeTokenValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Token = SHA-256 от конкатенации значений всех полей (включая Password),
 * отсортированных по имени ключа (как в официальной документации T-API)
 */
function generateTBankToken(
  params: Record<string, unknown>,
  password: string
): string {
  const payloadWithPassword = {
    ...params,
    Password: password,
  };

  const data = Object.keys(payloadWithPassword)
    .sort()
    .map((key) => serializeTokenValue(payloadWithPassword[key]))
    .join('');

  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function POST(req: Request) {
  try {
    const internalKey = req.headers.get(INTERNAL_KEY_HEADER);
    if (internalKey !== process.env.INTERNAL_KEY) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const userId = Number(body?.userId);
    const plan = body?.plan as Plan;
    const term = body?.term as Term;

    if (!Number.isFinite(userId) || userId <= 0) {
      return Response.json({ error: 'Invalid userId' }, { status: 400 });
    }

    if (!PLAN_PRICING[plan] || !PLAN_PRICING[plan][term]) {
      return Response.json({ error: 'Invalid plan or term' }, { status: 400 });
    }

    const terminalKey = process.env.TBANK_TERMINAL_ID;
    const password = process.env.TBANK_PASSWORD;
    const returnUrl = process.env.TBANK_RETURN_URL ?? 'https://t.me/RaspilPakBot';
    const notificationUrl = `${process.env.APP_BASE_URL ?? ''}/api/billing/webhook`;

    if (!terminalKey || !password) {
      return Response.json({ error: 'T-Bank credentials are not configured' }, { status: 500 });
    }

    const amount = PLAN_PRICING[plan][term];
    const amountKopecks = Math.round(amount * 100);
    // Кодируем plan и term в OrderId для восстановления в webhook
    const orderId = `order-${userId}-${plan}-${term}-${Date.now()}`;
    const description = `Подписка ${plan.toUpperCase()} на ${term === '30d' ? '30 дней' : '365 дней'}`;

    // DATA убираем полностью, так как Tinkoff API не может правильно десериализовать объект
    // Данные userId, plan, term кодируем в OrderId: order-{userId}-{plan}-{term}-{timestamp}
    const requestPayload: Record<string, unknown> = {
      TerminalKey: terminalKey,
      Amount: amountKopecks,
      OrderId: orderId,
      Description: description,
      SuccessURL: returnUrl,
      FailURL: returnUrl,
      NotificationURL: notificationUrl,
      CustomerKey: userId.toString(),
    };

    const token = generateTBankToken(requestPayload, password);
    const bodyWithToken = { ...requestPayload, Token: token };

    // Логируем тело запроса для отладки
    console.log('Request payload:', JSON.stringify(bodyWithToken, null, 2));

    let paymentUrl: string | undefined;
    
    try {
      const response = await axios.post(T_BANK_INIT_URL, bodyWithToken, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      if (response.data?.Success === true && response.data?.PaymentURL) {
        paymentUrl = response.data.PaymentURL;
      } else {
        console.error('Tinkoff API error:', {
          Success: response.data?.Success,
          ErrorCode: response.data?.ErrorCode,
          Message: response.data?.Message,
          Details: response.data?.Details,
        });
      }
    } catch (error: any) {
      console.error('Tinkoff API request failed:', {
        message: error?.message,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        url: error?.config?.url,
      });
    }

    if (!paymentUrl) {
      return Response.json({ 
        error: 'Failed to create payment link',
        details: 'Tinkoff API returned an error or invalid response'
      }, { status: 502 });
    }

    return Response.json({ ok: true, paymentUrl, orderId });
  } catch (err: any) {
    console.error('Create payment link error:', err?.message || err);
    return Response.json({ error: 'Ошибка при создании ссылки' }, { status: 500 });
  }
}

