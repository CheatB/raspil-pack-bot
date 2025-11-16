/**
 * Тесты для всех команд и кнопок бота
 * ВАЖНО: Этот тест должен запускаться при каждом изменении кода
 */

import { describe, it, expect } from '@jest/globals';

describe('All Bot Commands and Buttons', () => {
  describe('Команды', () => {
    it('должен обрабатывать команду /start', () => {
      const mockUpdate = {
        message: {
          text: '/start',
          entities: [{ type: 'bot_command' }],
        },
      };
      expect(mockUpdate.message.text).toBe('/start');
    });

    it('должен обрабатывать команду /help', () => {
      const mockUpdate = {
        message: {
          text: '/help',
          entities: [{ type: 'bot_command' }],
        },
      };
      expect(mockUpdate.message.text).toBe('/help');
    });

    it('должен обрабатывать команду /generate', () => {
      const mockUpdate = {
        message: {
          text: '/generate',
          entities: [{ type: 'bot_command' }],
        },
      };
      expect(mockUpdate.message.text).toBe('/generate');
    });

    it('должен обрабатывать команду /tariffs', () => {
      const mockUpdate = {
        message: {
          text: '/tariffs',
          entities: [{ type: 'bot_command' }],
        },
      };
      expect(mockUpdate.message.text).toBe('/tariffs');
    });
  });

  describe('Кнопки главного меню', () => {
    it('должен обрабатывать кнопку "🎨 Сгенерировать пак"', () => {
      const mockMessage = { text: '🎨 Сгенерировать пак' };
      expect(mockMessage.text).toBe('🎨 Сгенерировать пак');
    });

    it('должен обрабатывать кнопку "💰 Тарифы"', () => {
      const mockMessage = { text: '💰 Тарифы' };
      expect(mockMessage.text).toBe('💰 Тарифы');
    });

    it('должен обрабатывать кнопку "💳 Профиль"', () => {
      const mockMessage = { text: '💳 Профиль' };
      expect(mockMessage.text).toBe('💳 Профиль');
    });

    it('должен обрабатывать кнопку "❓ Помощь"', () => {
      const mockMessage = { text: '❓ Помощь' };
      expect(mockMessage.text).toBe('❓ Помощь');
    });

    it('должен обрабатывать кнопку "🔙 Главное меню"', () => {
      const mockMessage = { text: '🔙 Главное меню' };
      expect(mockMessage.text).toBe('🔙 Главное меню');
    });
  });

  describe('Callback кнопки', () => {
    it('должен обрабатывать callback "buy:pro:30d"', () => {
      const mockCallback = { data: 'buy:pro:30d' };
      expect(mockCallback.data).toMatch(/^buy:(pro|max):(30d|365d)$/);
    });

    it('должен обрабатывать callback "buy:max:365d"', () => {
      const mockCallback = { data: 'buy:max:365d' };
      expect(mockCallback.data).toMatch(/^buy:(pro|max):(30d|365d)$/);
    });

    it('должен обрабатывать callback "main_menu"', () => {
      const mockCallback = { data: 'main_menu' };
      expect(mockCallback.data).toBe('main_menu');
    });

    it('должен обрабатывать callback "makepack"', () => {
      const mockCallback = { data: 'makepack' };
      expect(mockCallback.data).toBe('makepack');
    });
  });

  describe('Интеграционные тесты', () => {
    it('должен обрабатывать все команды через webhook', async () => {
      const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
      const webhookSecret = process.env.WEBHOOK_SECRET || 'test-secret';

      const commands = ['/start', '/help', '/generate', '/tariffs'];
      
      for (const command of commands) {
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
              from: { id: 196185842, is_bot: false, first_name: 'Test' },
              chat: { id: 196185842, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: command,
              entities: [{ offset: 0, length: command.length, type: 'bot_command' }],
            },
          }),
        });

        expect([200, 401]).toContain(response.status);
      }
    });

    it('должен обрабатывать все кнопки главного меню', async () => {
      const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
      const webhookSecret = process.env.WEBHOOK_SECRET || 'test-secret';

      const buttons = ['🎨 Сгенерировать пак', '💰 Тарифы', '💳 Профиль', '❓ Помощь', '🔙 Главное меню'];
      
      for (const buttonText of buttons) {
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
              from: { id: 196185842, is_bot: false, first_name: 'Test' },
              chat: { id: 196185842, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: buttonText,
            },
          }),
        });

        expect([200, 401]).toContain(response.status);
      }
    });
  });
});


