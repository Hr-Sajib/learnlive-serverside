import { z } from 'zod';
import { paginationQuery } from '@/modules/shared/common.validation';

export const createBatchSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(24)
    .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and hyphens only, e.g. B12-FRONTEND'),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
});

export const updateBatchSchema = createBatchSchema
  .omit({ code: true })
  .extend({ status: z.enum(['active', 'archived']).optional() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listBatchesQuery = paginationQuery.extend({
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().trim().max(80).optional(),
});
