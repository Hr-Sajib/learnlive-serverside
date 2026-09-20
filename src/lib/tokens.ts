import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Response } from 'express';
import { config } from '@/config';
import type { UserRole } from '@/models/user.model';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export const ACCESS_COOKIE = 'll_token';
export const REFRESH_COOKIE = 'll_refresh';

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ role: payload.role }, config.jwt.accessSecret, {
    subject: payload.sub,
    expiresIn: config.jwt.accessExpiresIn,
  } as SignOptions);
}

export function signRefreshToken(sub: string): string {
  return jwt.sign({}, config.jwt.refreshSecret, {
    subject: sub,
    expiresIn: config.jwt.refreshExpiresIn,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.jwt.accessSecret) as jwt.JwtPayload;
  return { sub: String(decoded.sub), role: decoded.role as UserRole };
}

export function verifyRefreshToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, config.jwt.refreshSecret) as jwt.JwtPayload;
  return { sub: String(decoded.sub) };
}

/** Refresh tokens are stored only as a hash, so a database leak cannot replay them. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: config.isProd,
    // 'none' in production because the Next.js app and the API sit on
    // different domains (Vercel + Render) and the browser would otherwise
    // drop the cookie on every cross-site fetch.
    sameSite: config.isProd ? ('none' as const) : ('lax' as const),
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(15 * MINUTE));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(30 * DAY));
}

export function clearAuthCookies(res: Response): void {
  const opts = {
    httpOnly: true,
    secure: config.isProd,
    sameSite: config.isProd ? ('none' as const) : ('lax' as const),
    path: '/',
  };
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
}

/** Expiry of a refresh token as a Date, for the session row's TTL index. */
export function refreshExpiryDate(): Date {
  return new Date(Date.now() + 30 * DAY);
}
