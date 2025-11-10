import { envSchema, type Env } from '@repo/types';

function getEnv(): Env {
  const rawEnv = {
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    INTERNAL_KEY: process.env.INTERNAL_KEY,
    APP_BASE_URL: process.env.APP_BASE_URL,
    NODE_ENV: process.env.NODE_ENV || 'development',
  };

  return envSchema.parse(rawEnv);
}

export const env = getEnv();

