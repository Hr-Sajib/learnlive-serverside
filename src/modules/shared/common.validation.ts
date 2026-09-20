import mongoose from 'mongoose';
import { z } from 'zod';

export const objectId = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), { message: 'Not a valid id' });

export const idParam = z.object({ id: objectId });

/** Every list endpoint accepts this. `meta` in the response mirrors it back. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationQuery>;

export const skipOf = (p: Pagination): number => (p.page - 1) * p.limit;
