import { Router } from 'express';
import { authenticate, requireAdmin } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { idParam } from '@/modules/shared/common.validation';
import * as controller from '@/modules/batches/batch.controller';
import * as attendance from '@/modules/attendance/attendance.controller';
import {
  createBatchSchema,
  listBatchesQuery,
  updateBatchSchema,
} from '@/modules/batches/batch.validation';
import { batchAnalyticsQuery } from '@/modules/attendance/attendance.validation';

const router = Router();

router.use(authenticate);

router.get('/', requireAdmin, validate({ query: listBatchesQuery }), controller.listBatches);
router.post('/', requireAdmin, validate({ body: createBatchSchema }), controller.createBatch);

router.get('/:id', validate({ params: idParam }), controller.getBatch);
router.get('/:id/students', validate({ params: idParam }), controller.listBatchStudents);

router.patch(
  '/:id',
  requireAdmin,
  validate({ params: idParam, body: updateBatchSchema }),
  controller.updateBatch,
);

router.get(
  '/:id/analytics',
  requireAdmin,
  validate({ params: idParam, query: batchAnalyticsQuery }),
  attendance.batchAnalytics,
);

export const batchRoutes = router;
