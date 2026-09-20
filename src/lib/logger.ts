import pino from 'pino';
import { config } from '@/config';

export const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  ...(config.isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'],
    remove: true,
  },
});
