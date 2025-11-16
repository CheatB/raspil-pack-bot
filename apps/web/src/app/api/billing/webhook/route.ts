import { prisma } from '@/lib/prisma';

type WebhookBody = {
  TerminalKey?: string;
  terminal_id?: string;
  OrderId?: string | number;
  order_id?: string | number;
  Status?: string;
  status?: string;
  Success?: boolean;
  Amount?: number;
  amount?: number;
  DATA?: string;
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
    
    // Т-Банк может использовать разные названия параметров
    const terminalKey = body.TerminalKey || body.terminal_id;
    const orderId = body.OrderId || body.order_id;
    const status = (body.Status || body.status || '').toUpperCase();
    const success = body.Success !== undefined ? body.Success : status === 'SUCCESS' || status === 'CONFIRMED';
    const amount = body.Amount || body.amount || 0;
    
    // Определяем тип неуспешного платежа
    const isCancelled = status === 'CANCELED' || status === 'CANCELLED' || status === 'REVERSED' || status === 'PARTIAL_REVERSED';
    const isRefunded = status === 'REFUNDED' || status === 'PARTIAL_REFUNDED';
    const isRejected = status === 'REJECTED' || status === 'DECLINED';

    if (!terminalKey || terminalKey !== process.env.TBANK_TERMINAL_ID) {
      return Response.json({ error: 'Invalid terminal' }, { status: 403 });
    }

    // Парсим custom data из DATA параметра, custom_data или из OrderId
    // Делаем это до проверки success, чтобы иметь userId для отправки сообщения
    let customData: { userId?: number; plan?: string; term?: string } = {};
    
    // Сначала пробуем из DATA или custom_data
    if (body.DATA) {
      try {
        customData = typeof body.DATA === 'string' ? JSON.parse(body.DATA) : body.DATA;
      } catch {
        // Игнорируем ошибки парсинга
      }
    } else if (body.custom_data) {
      customData = body.custom_data;
    }
    
    // Если данных нет, пытаемся извлечь из OrderId: order-{userId}-{plan}-{term}-{timestamp}
    if (!customData.userId || !customData.plan || !customData.term) {
      const orderIdStr = String(orderId || '');
      const match = orderIdStr.match(/^order-(\d+)-(\w+)-(\w+)-/);
      if (match) {
        customData.userId = Number(match[1]);
        customData.plan = match[2];
        customData.term = match[3];
      }
    }

    // Если оплата не прошла, отправляем сообщение пользователю
    if (!success) {
      const userIdRaw = customData.userId;
      if (userIdRaw && Number.isFinite(Number(userIdRaw)) && Number(userIdRaw) > 0) {
        const userIdNumber = Number(userIdRaw);
        try {
          // Определяем статус и сообщение в зависимости от типа неуспешного платежа
          let paymentStatus: string;
          let message: string;
          
          if (isCancelled) {
            paymentStatus = 'CANCELLED';
            message = '❌ Платеж был отменен.\n\n' +
              'Если вы отменили платеж самостоятельно, вы можете попробовать оплатить снова.\n\n' +
              'Если отмена произошла по ошибке, пожалуйста, попробуйте использовать другую карту или обратитесь в поддержку вашего банка.';
          } else if (isRefunded) {
            paymentStatus = 'REFUNDED';
            message = '💰 Средства были возвращены на вашу карту.\n\n' +
              'Если вы запросили возврат средств, он будет обработан в течение нескольких рабочих дней.\n\n' +
              'Если возврат произошел по ошибке, пожалуйста, обратитесь в поддержку.';
          } else if (isRejected) {
            paymentStatus = 'REJECTED';
            message = '❌ Платеж был отклонен банком.\n\n' +
              'Возможные причины:\n' +
              '• Недостаточно средств на карте\n' +
              '• Карта заблокирована или истек срок действия\n' +
              '• Банк отклонил транзакцию по соображениям безопасности\n\n' +
              'Пожалуйста, используйте другую карту и попробуйте снова.\n\n' +
              'Если проблема сохраняется, обратитесь в поддержку вашего банка.';
          } else {
            // Общий случай неуспешного платежа
            paymentStatus = 'FAILED';
            message = '❌ К сожалению, оплата не прошла.\n\n' +
              'Возможные причины:\n' +
              '• Недостаточно средств на карте\n' +
              '• Карта заблокирована или истек срок действия\n' +
              '• Банк отклонил транзакцию\n\n' +
              'Пожалуйста, используйте другую карту и попробуйте снова.\n\n' +
              'Если проблема сохраняется, обратитесь в поддержку вашего банка.';
          }
          
          // Сохраняем информацию о неуспешном платеже
          await prisma.payment.create({
            data: {
              userId: BigInt(userIdNumber),
              plan: paymentStatus,
              termDays: 0,
              amount: Number(amount), // Храним в копейках (amount приходит в копейках от T-Bank)
              currency: 'RUB',
              status: paymentStatus,
              invoiceId: orderId?.toString(),
            },
          }).catch(() => {
            // Игнорируем ошибки сохранения в БД
          });

          // Отправляем сообщение пользователю
          const { Telegraf } = await import('telegraf');
          const bot = new Telegraf(process.env.TG_BOT_TOKEN ?? '');
          await bot.telegram.sendMessage(userIdNumber, message).catch(() => {
            // Игнорируем ошибки отправки сообщения
          });
        } catch (error) {
          // Логируем ошибку, но не прерываем выполнение
          console.error('Error sending payment failure message:', error);
        }
      }
      return Response.json({ ok: true, message: 'Payment not successful', status });
    }

    // customData уже извлечен выше при обработке неуспешного платежа

    const userIdRaw = customData.userId;
    const planRaw = customData.plan;
    const termRaw = customData.term;

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
    // Поддерживаем только pro, но оставляем max для обратной совместимости
    if (plan !== 'pro' && plan !== 'max') {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }
    
    // Если plan = 'max', конвертируем в 'pro' (Max тариф больше не продается)
    const actualPlan = plan === 'max' ? 'pro' : plan;

    const term = String(termRaw);
    const days = term === '365d' ? 365 : 30;

    const userId = BigInt(userIdNumber);
    const now = new Date();
    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    
    // Проверяем, была ли уже активирована подписка для этого заказа
    const existingPayment = await prisma.payment.findFirst({
      where: {
        invoiceId: orderId?.toString(),
        status: 'PAID',
      },
    });

    // Если платеж уже был обработан, не отправляем сообщение повторно
    if (existingPayment) {
      return Response.json({ ok: true, message: 'Payment already processed' });
    }

    const baseDate =
      existingUser?.paidUntil && existingUser.paidUntil > now ? existingUser.paidUntil : now;
    const paidUntil = new Date(baseDate.getTime() + days * 86400 * 1000);
    // Все платные тарифы теперь PRO (Max больше не продается)
    const statusUpper = 'PRO';

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
        amount: Number(amount), // Храним в копейках (amount приходит в копейках от T-Bank)
        currency: 'RUB',
        status: 'PAID',
        invoiceId: orderId?.toString(),
      },
    });

    try {
      const { Telegraf } = await import('telegraf');
      const bot = new Telegraf(process.env.TG_BOT_TOKEN ?? '');
      await bot.telegram.sendMessage(
        userIdNumber,
        `✅ Подписка PRO активирована на ${days} дней!\nТеперь ты можешь создавать большие паки без бренда 🎉`
      );
    } catch {
      // Игнорируем ошибки уведомления
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}

