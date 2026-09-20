import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Error as MongooseError } from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '@/utils/AppError';
import { config } from '@/config';
import { logger } from '@/lib/logger';

interface MongoServerError extends Error {
  code?: number;
  keyValue?: Record<string, unknown>;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    message: `No route matches ${req.method} ${req.originalUrl}.`,
    code: 'ROUTE_NOT_FOUND',
  });
}

// Express identifies an error handler by its four parameters, so `_next`
// must stay even though it is unused.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  let statusCode: number = StatusCodes.INTERNAL_SERVER_ERROR;
  let message = 'Something went wrong on our end. Please try again.';
  let code = 'INTERNAL_ERROR';
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = 'Some fields need attention.';
    code = 'VALIDATION_ERROR';
    details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  } else if (err instanceof MongooseError.ValidationError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = 'Some fields need attention.';
    code = 'VALIDATION_ERROR';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err instanceof MongooseError.CastError) {
    statusCode = StatusCodes.BAD_REQUEST;
    message = `"${String(err.value)}" is not a valid ${err.path}.`;
    code = 'INVALID_ID';
  } else if (isDuplicateKey(err)) {
    statusCode = StatusCodes.CONFLICT;
    const field = Object.keys(err.keyValue ?? {})[0] ?? 'value';
    message = `That ${humanise(field)} is already registered.`;
    code = 'DUPLICATE_KEY';
    details = { field };
  }

  const logPayload = {
    err,
    statusCode,
    code,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id,
  };

  // 5xx is our bug and deserves a full stack; 4xx is the client's input.
  if (statusCode >= 500) logger.error(logPayload, message);
  else logger.warn({ ...logPayload, err: undefined }, message);

  res.status(statusCode).json({
    success: false,
    message,
    code,
    ...(details ? { details } : {}),
    // A stack trace in a production response is a gift to an attacker.
    ...(config.isProd ? {} : { stack: err instanceof Error ? err.stack : undefined }),
  });
}

function isDuplicateKey(err: unknown): err is MongoServerError {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as MongoServerError).code === 11000
  );
}

function humanise(field: string): string {
  const last = field.split('.').pop() ?? field;
  return last.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}
