import { z } from 'zod';
import { objectId, paginationQuery } from '@/modules/shared/common.validation';

export const listUsersQuery = paginationQuery.extend({
  status: z.enum(['pending', 'verified', 'rejected', 'suspended']).default('pending'),
  batchId: objectId.optional(),
  search: z.string().trim().max(80).optional(),
});

/** An admin may place the student in a different batch than the code they typed. */
export const verifyUserSchema = z.object({ batchId: objectId.optional() });

export const rejectUserSchema = z.object({
  reason: z.string().trim().min(5, 'Tell the student why').max(500),
});

export const suspendUserSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createAdminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^01[3-9]\d{8}$/, 'Enter a valid 11-digit mobile number'),
  password: z.string().min(8).max(72),
});
