import pino from 'pino';

// Упрощенная конфигурация логгера
// В development режиме логи выводятся в консоль через простой формат
// В production - только info и выше
const isDev = process.env.NODE_ENV === 'development';

// Используем простую конфигурацию без pino-pretty, чтобы избежать проблем с worker threads
export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev && {
    // В development используем простой формат без pino-pretty
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }),
});

