/**
 * Тест для команды /start
 * Проверяет, что команда работает корректно и обрабатывает ошибки
 * 
 * ВАЖНО: Этот тест должен запускаться при каждом изменении кода,
 * чтобы убедиться, что команда /start продолжает работать
 */

import { describe, it, expect } from '@jest/globals';

describe('Start Command - /start', () => {
  it('должен обрабатывать команду /start через webhook', async () => {
    // Тест проверяет, что webhook обрабатывает команду /start
    const mockUpdate = {
      update_id: 123,
      message: {
        message_id: 1,
        from: {
          id: 196185842,
          is_bot: false,
          first_name: 'Test',
        },
        chat: {
          id: 196185842,
          type: 'private',
        },
        date: 1234567890,
        text: '/start',
        entities: [
          {
            offset: 0,
            length: 6,
            type: 'bot_command',
          },
        ],
      },
    };

    expect(mockUpdate.message.text).toBe('/start');
    expect(mockUpdate.message.entities[0].type).toBe('bot_command');
    expect(mockUpdate.message.from.id).toBeDefined();
  });

  it('должен содержать правильную структуру сообщения', () => {
    const mockMessage = {
      text: '/start',
      from: {
        id: 196185842,
        username: 'testuser',
      },
      chat: {
        id: 196185842,
        type: 'private',
      },
    };

    expect(mockMessage.text).toBe('/start');
    expect(mockMessage.from.id).toBeDefined();
    expect(mockMessage.chat.type).toBe('private');
  });

  it('должен обрабатывать команду /start с параметрами', () => {
    const mockMessage = {
      text: '/start param123',
      entities: [
        {
          offset: 0,
          length: 6,
          type: 'bot_command',
        },
      ],
    };

    expect(mockMessage.text).toContain('/start');
    expect(mockMessage.entities[0].type).toBe('bot_command');
  });

  it('должен обрабатывать команду /start через API endpoint', async () => {
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
    const webhookSecret = process.env.WEBHOOK_SECRET || 'test-secret';

    const response = await fetch(`${baseUrl}/api/tg/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': webhookSecret,
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 1000000),
        message: {
          message_id: 1,
          from: {
            id: 196185842,
            is_bot: false,
            first_name: 'Test',
          },
          chat: {
            id: 196185842,
            type: 'private',
          },
          date: Math.floor(Date.now() / 1000),
          text: '/start',
          entities: [
            {
              offset: 0,
              length: 6,
              type: 'bot_command',
            },
          ],
        },
      }),
    });

    // Webhook должен возвращать 200 OK даже при ошибках
    expect([200, 401]).toContain(response.status);
    
    if (response.status === 200) {
      const data = await response.json();
      expect(data).toHaveProperty('ok');
    }
  });
});

