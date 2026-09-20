import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { apiRoutes } from '@/routes';
import { errorHandler, notFoundHandler } from '@/middleware/error';
import { blockOperatorInjection } from '@/middleware/validate';
import { generalLimiter } from '@/middleware/rateLimit';
import { handleLiveKitWebhook } from '@/modules/webhooks/livekit.webhook';

export function createApp(): express.Express {
  const app = express();

  // Render, Railway and friends sit behind a proxy; without this every client
  // looks like it shares one IP and the rate limiters key on the wrong thing.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  /**
   * The LiveKit webhook is mounted BEFORE the JSON parser and with a raw body
   * parser of its own. Its signature is computed over the exact bytes LiveKit
   * sent, so any upstream reparsing would break verification.
   */
  app.post(
    '/api/v1/webhooks/livekit',
    express.raw({ type: ['application/webhook+json', 'application/json'] }),
    handleLiveKitWebhook,
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(blockOperatorInjection);

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', env: config.env, time: new Date() } });
  });

  app.use('/api/v1', generalLimiter, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
