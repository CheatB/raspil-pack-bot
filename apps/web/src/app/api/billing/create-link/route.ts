import axios from 'axios';

const INTERNAL_KEY_HEADER = 'x-internal-key';

type Plan = 'pro' | 'max';
type Term = '30d' | '365d';

const PLAN_PRICING: Record<Plan, Record<Term, number>> = {
  pro: {
    '30d': 299,
    '365d': 1990,
  },
  max: {
    '30d': 399,
    '365d': 2490,
  },
};

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

    const amount = PLAN_PRICING[plan][term];
    const payload = {
      terminal_id: process.env.TBANK_TERMINAL_ID,
      amount,
      currency: 'RUB',
      description: `Подписка ${plan.toUpperCase()} на ${term === '30d' ? '30 дней' : '365 дней'}`,
      return_url: process.env.TBANK_RETURN_URL,
      custom_data: { userId, plan, term },
    };

    let paymentUrl: string | undefined;

    try {
      const response = await axios.post('https://ecommerce.tbank.ru/api/v1/pay', payload, {
        auth: {
          username: process.env.TBANK_TERMINAL_ID ?? '',
          password: process.env.TBANK_PASSWORD ?? '',
        },
      });

      if (response.data?.payment_url) {
        paymentUrl = response.data.payment_url;
      } else {
        console.warn('T-Bank response without payment_url:', response.data);
      }
    } catch (err: any) {
      console.error('Ошибка Т-Банк эквайринг:', err?.response?.data || err?.message || err);
    }

    if (!paymentUrl) {
      const terminalId = process.env.TBANK_TERMINAL_ID ?? '';
      const fallbackParams = new URLSearchParams({
        terminal_id: terminalId,
        amount: amount.toFixed(2),
        order_id: `test-${userId}-${Date.now()}`,
        description: payload.description,
      });

      const customData = JSON.stringify({ userId, plan, term });
      fallbackParams.append('custom_data', customData);

      const returnUrl = process.env.TBANK_RETURN_URL;
      if (returnUrl) {
        fallbackParams.append('return_url', returnUrl);
      }

      paymentUrl = `https://ecommerce.tbank.ru/payform?${fallbackParams.toString()}`;
    }

    return Response.json({ ok: true, paymentUrl });
  } catch (err: any) {
    console.error('Ошибка Т-Банк эквайринг:', err?.response?.data || err?.message || err);
    return Response.json({ error: 'Ошибка при создании ссылки' }, { status: 500 });
  }
}

