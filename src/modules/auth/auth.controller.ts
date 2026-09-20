import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '@/utils/asyncHandler';
import { sendResponse } from '@/utils/sendResponse';
import { REFRESH_COOKIE, clearAuthCookies } from '@/lib/tokens';
import { User } from '@/models/user.model';
import { unauthorized } from '@/utils/AppError';
import * as authService from '@/modules/auth/auth.service';

const contextOf = (req: { headers: Record<string, unknown>; ip?: string }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

export const register = asyncHandler(async (req, res) => {
  const user = await authService.register(req.body);
  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    message:
      'Registration received. An admin will verify your account shortly, and you can sign in once they do.',
    data: user,
  });
});

export const login = asyncHandler(async (req, res) => {
  const user = await authService.login(req.body, res, contextOf(req));
  sendResponse(res, { message: `Welcome back, ${user.name}.`, data: user });
});

export const refresh = asyncHandler(async (req, res) => {
  const user = await authService.refresh(req.cookies?.[REFRESH_COOKIE], res, contextOf(req));
  sendResponse(res, { data: user });
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  sendResponse(res, { message: 'Signed out.', data: null });
});

export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user!.id);
  if (!user) throw unauthorized();
  sendResponse(res, { data: await authService.toPublicUser(user) });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
  clearAuthCookies(res);
  sendResponse(res, { message: 'Password updated. Please sign in again.', data: null });
});
