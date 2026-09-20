import { StatusCodes } from 'http-status-codes';

/** An error we raised deliberately and can safely show the client. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational = true;

  constructor(statusCode: number, message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(StatusCodes.BAD_REQUEST, message, code, details);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(StatusCodes.UNAUTHORIZED, message, 'UNAUTHORIZED');

export const forbidden = (message = 'You do not have access to this.') =>
  new AppError(StatusCodes.FORBIDDEN, message, 'FORBIDDEN');

export const notFound = (what = 'Resource') =>
  new AppError(StatusCodes.NOT_FOUND, `${what} not found.`, 'NOT_FOUND');

export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(StatusCodes.CONFLICT, message, code, details);

export const tooManyRequests = (message = 'Too many requests. Please slow down.') =>
  new AppError(StatusCodes.TOO_MANY_REQUESTS, message, 'RATE_LIMITED');

/** The account exists and the password is right, but an admin has not approved it yet. */
export const accountPending = () =>
  new AppError(
    StatusCodes.FORBIDDEN,
    'Your account is waiting for admin approval. You will be able to sign in once a batch admin verifies you.',
    'ACCOUNT_PENDING',
  );

export const accountRejected = (reason?: string) =>
  new AppError(
    StatusCodes.FORBIDDEN,
    reason
      ? `Your registration was declined: ${reason}`
      : 'Your registration was declined. Please contact your batch admin.',
    'ACCOUNT_REJECTED',
  );
