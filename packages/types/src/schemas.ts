import { z } from 'zod';

// Environment variables schema
export const envSchema = z.object({
  TG_BOT_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  INTERNAL_KEY: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

// Pack metadata schema
export const packMetadataSchema = z.object({
  id: z.string().uuid(),
  userId: z.number(),
  userName: z.string().optional(),
  createdAt: z.date(),
  mediaType: z.enum(['photo', 'video', 'animation']),
  tileCount: z.number().int().positive().optional(),
  padding: z.number().int().nonnegative().optional(),
  processed: z.boolean().default(false),
});

export type PackMetadata = z.infer<typeof packMetadataSchema>;

// User quota schema
export const userQuotaSchema = z.object({
  userId: z.number(),
  month: z.string(), // YYYY-MM
  count: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(5),
});

export type UserQuota = z.infer<typeof userQuotaSchema>;

// Mosaic options schema
export const mosaicOptionsSchema = z.object({
  tileCount: z.number().int().positive().min(9).max(15).optional(),
  padding: z.number().int().nonnegative().default(0),
});

export type MosaicOptions = z.infer<typeof mosaicOptionsSchema>;

