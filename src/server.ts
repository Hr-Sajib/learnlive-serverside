import { createApp } from '@/app';
import { config } from '@/config';
import { connectDB, disconnectDB } from '@/lib/db';
import { logger } from '@/lib/logger';
import { startPresenceReconciler, stopPresenceReconciler } from '@/jobs/reconcilePresence';

async function bootstrap(): Promise<void> {
  await connectDB();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`LearnLive API listening on :${config.port} (${config.env})`);
    if (!config.livekit.isConfigured) {
      logger.warn('LIVEKIT_* is not set — live classes and attendance tracking are disabled.');
    }
  });

  startPresenceReconciler();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopPresenceReconciler();
    server.close(() => {
      void disconnectDB().finally(() => process.exit(0));
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
