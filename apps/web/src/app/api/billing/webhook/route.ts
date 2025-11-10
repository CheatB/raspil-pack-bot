import { prisma } from '@/lib/prisma';

type WebhookBody = {
  terminal_id?: string;
  order_id?: string | number;
  status?: string;
  amount?: number;
  custom_data?: {
    userId?: number;
    plan?: string;
    term?: string;
    [key: string]: any;
  };
  [key: string]: any;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as WebhookBody;
    const { terminal_id, order_id, status, custom_data } = body;

    if (!terminal_id || terminal_id !== process.env.TBANK_TERMINAL_ID) {
      return Response.json({ error: 'Invalid terminal' }, { status: 403 });
    }

    if (status !== 'success') {
      return Response.json({ ok: true, message: 'Payment not successful' });
    }

    const userIdRaw = custom_data?.userId;
    const planRaw = custom_data?.plan;
    const termRaw = custom_data?.term;

    if (
      typeof userIdRaw === 'undefined' ||
      typeof planRaw === 'undefined' ||
      typeof termRaw === 'undefined'
    ) {
      return Response.json({ error: 'Missing custom_data fields' }, { status: 400 });
    }

    const userIdNumber = Number(userIdRaw);
    if (!Number.isFinite(userIdNumber) || userIdNumber <= 0) {
      return Response.json({ error: 'Invalid userId' }, { status: 400 });
    }

    const plan = String(planRaw).toLowerCase();
    if (plan !== 'pro' && plan !== 'max') {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const term = String(termRaw);
    const days = term === '365d' ? 365 : 30;

    const userId = BigInt(userIdNumber);
    const now = new Date();
    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    const baseDate =
      existingUser?.paidUntil && existingUser.paidUntil > now ? existingUser.paidUntil : now;
    const paidUntil = new Date(baseDate.getTime() + days * 86400 * 1000);
    const statusUpper = plan.toUpperCase();

    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        status: statusUpper,
        paidUntil,
      },
      update: {
        status: statusUpper,
        paidUntil,
      },
    });

    await prisma.payment.create({
      data: {
        userId,
        plan: statusUpper,
        termDays: days,
        amount: Number(body.amount) || 0,
        currency: 'RUB',
        status: 'PAID',
        invoiceId: order_id?.toString(),
      },
    });

    try {
      const { Telegraf } = await import('telegraf');
      const bot = new Telegraf(process.env.TG_BOT_TOKEN ?? '');
      await bot.telegram.sendMessage(
        userIdNumber,
        `✅ Подписка ${statusUpper} активирована на ${days} дней!\nТеперь ты можешь создавать большие паки без бренда 🎉`
      );
    } catch (notifyError) {
      console.error('Ошибка уведомления пользователя:', notifyError);
    }

    return Response.json({ ok: true });
  } catch (error: any) {
    console.error('Ошибка обработки вебхука Т-Банка:', error?.message || error);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

