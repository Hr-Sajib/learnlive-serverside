import { z } from 'zod';

/** Bangladeshi mobile numbers, the format every student here will type. */
const phone = z
  .string()
  .trim()
  .regex(/^01[3-9]\d{8}$/, 'Enter a valid 11-digit mobile number, e.g. 01712345678');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your full name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone,
  password,
  batchCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'Enter the batch code your coach gave you')
    .max(24),
});

/** Students sign in with whichever of the two they remember. */
export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or mobile number'),
  password: z.string().min(1, 'Enter your password'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
