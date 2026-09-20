import rateLimit from 'express-rate-limit';

/** Blunt protection on credential endpoints. Keyed by IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please wait a few minutes and try again.',
    code: 'RATE_LIMITED',
  },
});

/**
 * The heartbeat fires every 30s per student. This ceiling is high enough for
 * honest clients and low enough to stop a script hammering the endpoint.
 */
export const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
