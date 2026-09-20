import argon2 from 'argon2';
import type { Response } from 'express';
import { Batch } from '@/models/batch.model';
import { Session } from '@/models/session.model';
import { User, type IUser } from '@/models/user.model';
import {
  hashToken,
  refreshExpiryDate,
  setAuthCookies,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@/lib/tokens';
import {
  accountPending,
  accountRejected,
  badRequest,
  conflict,
  forbidden,
  unauthorized,
} from '@/utils/AppError';
import type { LoginInput, RegisterInput } from '@/modules/auth/auth.validation';

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain);

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: IUser['role'];
  status: IUser['status'];
  batch: { id: string; code: string; title: string } | null;
  createdAt: Date;
}

export async function toPublicUser(user: IUser): Promise<PublicUser> {
  const batch = user.batch ? await Batch.findById(user.batch).select('code title').lean() : null;

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    batch: batch ? { id: String(batch._id), code: batch.code, title: batch.title } : null,
    createdAt: user.createdAt,
  };
}

/**
 * Creates a student account in `pending` and parks it in the admin queue.
 *
 * No tokens are issued here. A student who could sign in the instant they
 * registered would be inside the batch community before anyone confirmed they
 * belong there, which is the entire point of the verification step.
 */
export async function register(input: RegisterInput): Promise<PublicUser> {
  const batch = await Batch.findOne({ code: input.batchCode }).lean();
  if (!batch) {
    throw badRequest(
      `No batch is registered under the code "${input.batchCode}". Please check the code your coach gave you.`,
      'UNKNOWN_BATCH_CODE',
    );
  }
  if (batch.status !== 'active') {
    throw badRequest(`Batch ${batch.code} is no longer accepting registrations.`, 'BATCH_ARCHIVED');
  }

  const existing = await User.findOne({ $or: [{ email: input.email }, { phone: input.phone }] }).lean();
  if (existing) {
    const field = existing.email === input.email ? 'email address' : 'mobile number';
    throw conflict(`That ${field} is already registered. Try signing in instead.`, 'DUPLICATE_USER', {
      field: existing.email === input.email ? 'email' : 'phone',
    });
  }

  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    role: 'student',
    status: 'pending',
    batch: batch._id,
    requestedBatchCode: batch.code,
  });

  return toPublicUser(user);
}

/**
 * Verifies credentials and issues a token pair.
 *
 * The password is checked BEFORE the account status, deliberately. Reporting
 * "awaiting approval" to anyone who types an email would turn the login form
 * into a way of discovering who has registered.
 */
export async function login(
  input: LoginInput,
  res: Response,
  context: { userAgent?: string; ip?: string },
): Promise<PublicUser> {
  const identifier = input.identifier.trim().toLowerCase();

  const user = await User.findOne({ $or: [{ email: identifier }, { phone: identifier }] }).select(
    '+passwordHash',
  );

  // Same message either way, so a wrong password is indistinguishable from an
  // email that was never registered.
  const invalid = unauthorized('That email/mobile and password combination does not match.');
  if (!user) throw invalid;

  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) throw invalid;

  if (user.status === 'pending') throw accountPending();
  if (user.status === 'rejected') throw accountRejected(user.rejectionReason ?? undefined);
  if (user.status === 'suspended') throw forbidden('Your account has been suspended.');

  await issueSession(user, res, context);

  user.lastLoginAt = new Date();
  await user.save();

  return toPublicUser(user);
}

/** Mints a token pair, sets the cookies, and records the refresh grant. */
export async function issueSession(
  user: IUser,
  res: Response,
  context: { userAgent?: string; ip?: string },
): Promise<void> {
  const accessToken = signAccessToken({ sub: String(user._id), role: user.role });
  const refreshToken = signRefreshToken(String(user._id));

  await Session.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
    expiresAt: refreshExpiryDate(),
  });

  setAuthCookies(res, accessToken, refreshToken);
}

/**
 * Rotates a refresh token.
 *
 * The old grant is deleted as part of the rotation, so a stolen refresh token
 * is usable at most once — and its use invalidates the legitimate holder's
 * session, which is the signal that something went wrong.
 */
export async function refresh(
  refreshToken: string | undefined,
  res: Response,
  context: { userAgent?: string; ip?: string },
): Promise<PublicUser> {
  if (!refreshToken) throw unauthorized('Your session has expired. Please sign in again.');

  let sub: string;
  try {
    sub = verifyRefreshToken(refreshToken).sub;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  const grant = await Session.findOneAndDelete({ tokenHash: hashToken(refreshToken) });
  if (!grant) throw unauthorized('Your session has expired. Please sign in again.');

  const user = await User.findById(sub);
  if (!user) throw unauthorized('That account no longer exists.');
  if (user.status !== 'verified') throw forbidden('Your account is not active.');

  await issueSession(user, res, context);
  return toPublicUser(user);
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await Session.deleteOne({ tokenHash: hashToken(refreshToken) });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw unauthorized();

  const ok = await argon2.verify(user.passwordHash, currentPassword);
  if (!ok) throw badRequest('Your current password is not correct.', 'WRONG_PASSWORD');

  user.passwordHash = await hashPassword(newPassword);
  await user.save();

  // Every other device is logged out, because a password change is how someone
  // reacts to suspecting their account is compromised.
  await Session.deleteMany({ user: user._id });
}
