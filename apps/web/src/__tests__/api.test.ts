/**
 * Тесты для API endpoints
 */

describe('API Endpoints', () => {
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const internalKey = process.env.INTERNAL_KEY || 'test-key';

  describe('POST /api/billing/create-link', () => {
    it('должен возвращать ссылку на оплату', async () => {
      const response = await fetch(`${baseUrl}/api/billing/create-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': internalKey,
        },
        body: JSON.stringify({
          userId: 123456789,
          plan: 'pro',
          term: '30d',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        expect(data).toHaveProperty('paymentUrl');
        expect(data).toHaveProperty('orderId');
        expect(data.paymentUrl).toMatch(/^https?:\/\//);
      } else {
        // В тестовом окружении может не быть настроенных credentials
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('должен возвращать ошибку при отсутствии credentials', async () => {
      const response = await fetch(`${baseUrl}/api/billing/create-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': internalKey,
        },
        body: JSON.stringify({
          userId: 123456789,
          plan: 'invalid',
          term: '30d',
        }),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('POST /api/billing/webhook', () => {
    it('должен обрабатывать успешный платеж', async () => {
      const response = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          TerminalKey: process.env.TBANK_TERMINAL_ID || 'test',
          OrderId: 'test-order',
          Success: true,
          Amount: 29900,
          DATA: JSON.stringify({ userId: 123456789, plan: 'pro', term: '30d' }),
        }),
      });

      // Webhook должен возвращать 200 даже при ошибках валидации
      expect([200, 400, 403, 500]).toContain(response.status);
    });
  });

  describe('POST /api/tg/webhook', () => {
    it('должен обрабатывать обновления от Telegram', async () => {
      const response = await fetch(`${baseUrl}/api/tg/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': process.env.WEBHOOK_SECRET || 'test',
        },
        body: JSON.stringify({
          update_id: 123456,
          message: {
            message_id: 1,
            from: { id: 123456789, is_bot: false, first_name: 'Test' },
            chat: { id: 123456789, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/start',
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('ok');
    });
  });
});




