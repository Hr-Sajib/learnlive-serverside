import { z } from 'zod';
import { objectId, paginationQuery } from '@/modules/shared/common.validation';

export const createClassSchema = z.object({
  batchId: objectId,
  title: z.string().trim().min(3, 'Give the class a title').max(160),
  description: z.string().trim().max(4000).optional().nullable(),
  scheduledStartAt: z.coerce.date(),
  scheduledDurationMin: z.coerce.number().int().min(5).max(600),
  /** Omitted means "use the server default", which is 60. */
  attendanceThresholdPct: z.coerce.number().int().min(1).max(100).optional(),
});

export const updateClassSchema = createClassSchema
  .omit({ batchId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listClassesQuery = paginationQuery.extend({
  batchId: objectId.optional(),
  status: z.enum(['scheduled', 'live', 'ended', 'cancelled']).optional(),
});

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type ListClassesQuery = z.infer<typeof listClassesQuery>;
