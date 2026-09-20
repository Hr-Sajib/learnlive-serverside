import type { NextFunction, Request, Response } from 'express';
import { ZodError, type AnyZodObject, type ZodTypeAny } from 'zod';
import { badRequest } from '@/utils/AppError';

interface Schemas {
  body?: ZodTypeAny;
  query?: AnyZodObject;
  params?: AnyZodObject;
}

/**
 * Validates and *replaces* the request parts with the parsed output, so
 * downstream handlers receive coerced, trimmed, defaulted values rather
 * than raw strings.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        // Express 5 makes req.query a getter, so assign onto it rather than replacing it.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
        return next(badRequest('Some fields need attention.', 'VALIDATION_ERROR', details));
      }
      next(err);
    }
  };
}

/**
 * Blocks Mongo operator injection. A body like `{ "email": { "$ne": null } }`
 * would otherwise become a query operator once it reaches a filter.
 */
export function blockOperatorInjection(req: Request, _res: Response, next: NextFunction): void {
  const offending = findDollarKey(req.body) ?? findDollarKey(req.query);
  if (offending) {
    return next(
      badRequest(`Field names cannot start with "$" or contain "." (${offending}).`, 'INVALID_KEY'),
    );
  }
  next();
}

function findDollarKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$') || key.includes('.')) return key;
    const nested = findDollarKey(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}
