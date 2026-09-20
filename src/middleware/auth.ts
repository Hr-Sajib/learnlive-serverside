import type { NextFunction, Request, Response } from 'express';
import { ACCESS_COOKIE, verifyAccessToken } from '@/lib/tokens';
import { User, type IUser, type UserRole } from '@/models/user.model';
import { accountPending, accountRejected, forbidden, unauthorized } from '@/utils/AppError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export interface AuthedUser {
  id: string;
  role: UserRole;
  status: IUser['status'];
  batchId: string | null;
  name: string;
  email: string;
}

function readToken(req: Request): string | null {
  const cookie = req.cookies?.[ACCESS_COOKIE];
  if (typeof cookie === 'string' && cookie) return cookie;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  return null;
}

/**
 * Verifies the access token and then re-reads the user from the database.
 *
 * The extra read is deliberate: an admin verifying, rejecting or suspending an
 * account must take effect immediately, and a token minted before that change
 * would otherwise keep asserting a stale status for its full 15-minute life.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();

    let sub: string;
    try {
      sub = verifyAccessToken(token).sub;
    } catch {
      throw unauthorized('Your session has expired. Please sign in again.');
    }

    const user = await User.findById(sub).select('name email role status batch').lean();
    if (!user) throw unauthorized('That account no longer exists.');

    if (user.status === 'pending') throw accountPending();
    if (user.status === 'rejected') throw accountRejected(undefined);
    if (user.status === 'suspended') {
      throw forbidden('Your account has been suspended. Please contact your batch admin.');
    }

    req.user = {
      id: String(user._id),
      role: user.role,
      status: user.status,
      batchId: user.batch ? String(user.batch) : null,
      name: user.name,
      email: user.email,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Route guard. Use after `authenticate`. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireStudent = requireRole('student');

/**
 * Asserts the caller may act on the given batch: admins may touch any batch,
 * a student only their own. Every batch-scoped route must call this, or a
 * student could read another community's roster by guessing an id.
 */
export function assertBatchAccess(req: Request, batchId: string): void {
  const user = req.user;
  if (!user) throw unauthorized();
  if (user.role === 'admin') return;
  if (user.batchId && user.batchId === String(batchId)) return;
  throw forbidden('You are not a member of that batch.');
}
