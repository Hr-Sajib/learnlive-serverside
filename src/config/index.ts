import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config({ path: path.join(process.cwd(), '.env') });

/**
 * Every environment variable the API needs, validated once at boot.
 * A missing or malformed value crashes the process here rather than
 * surfacing as a confusing runtime error three layers deep.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:5000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_HOST: z.string().optional(),
  LIVEKIT_WS_URL: z.string().optional(),

  ATTENDANCE_THRESHOLD_PCT: z.coerce.number().min(1).max(100).default(60),
  PRESENCE_RECONCILE_INTERVAL_SEC: z.coerce.number().int().min(15).max(600).default(60),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PHONE: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isDev: env.NODE_ENV === 'development',
  port: env.PORT,

  db: { uri: env.MONGODB_URI },

  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },

  appUrl: env.APP_URL,
  apiUrl: env.API_URL,
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  livekit: {
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    host: env.LIVEKIT_HOST,
    wsUrl: env.LIVEKIT_WS_URL,
    get isConfigured() {
      return Boolean(
        env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_HOST && env.LIVEKIT_WS_URL,
      );
    },
  },

  attendance: {
    thresholdPct: env.ATTENDANCE_THRESHOLD_PCT,
    reconcileIntervalSec: env.PRESENCE_RECONCILE_INTERVAL_SEC,
  },

  seed: {
    adminEmail: env.SEED_ADMIN_EMAIL,
    adminPhone: env.SEED_ADMIN_PHONE,
    adminPassword: env.SEED_ADMIN_PASSWORD,
  },
} as const;

export type Config = typeof config;
