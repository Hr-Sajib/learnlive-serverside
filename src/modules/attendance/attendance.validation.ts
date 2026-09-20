import { z } from 'zod';
import { objectId, paginationQuery } from '@/modules/shared/common.validation';

export const overrideAttendanceSchema = z.object({
  status: z.enum(['present', 'partial', 'absent']),
  reason: z.string().trim().min(5, 'Explain why you are overriding this').max(500),
});

export const myAttendanceQuery = paginationQuery.extend({
  batchId: objectId.optional(),
});

export const batchAnalyticsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type OverrideAttendanceInput = z.infer<typeof overrideAttendanceSchema>;
