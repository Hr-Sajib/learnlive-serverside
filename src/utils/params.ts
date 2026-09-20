import type { Request } from 'express';
import { badRequest } from '@/utils/AppError';

/**
 * Express 5 types a route param as `string | string[]`, because a pattern can
 * capture repeats. None of our routes do, so this narrows it once here rather
 * than forcing a cast at every call site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Missing "${name}" in the URL.`, 'MISSING_PARAM');
  }
  return value;
}
