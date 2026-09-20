import { Router } from 'express';
import { authenticate, requireAdmin } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { heartbeatLimiter } from '@/middleware/rateLimit';
import { idParam } from '@/modules/shared/common.validation';
import * as controller from '@/modules/classes/class.controller';
import * as attendance from '@/modules/attendance/attendance.controller';
import {
  createClassSchema,
  listClassesQuery,
  updateClassSchema,
} from '@/modules/classes/class.validation';

const router = Router();

router.use(authenticate);

/* ---- readable by any verified member of the batch ---- */
router.get('/', validate({ query: listClassesQuery }), controller.listClasses);
router.get('/:id', validate({ params: idParam }), controller.getClass);

/** Students and the host both use this to enter the room. */
router.post('/:id/join', validate({ params: idParam }), controller.joinClass);
router.post('/:id/heartbeat', heartbeatLimiter, validate({ params: idParam }), attendance.heartbeat);

/* ---- admin only ---- */
router.post('/', requireAdmin, validate({ body: createClassSchema }), controller.createClass);
router.patch(
  '/:id',
  requireAdmin,
  validate({ params: idParam, body: updateClassSchema }),
  controller.updateClass,
);
router.post('/:id/start', requireAdmin, validate({ params: idParam }), controller.startClass);
router.post('/:id/end', requireAdmin, validate({ params: idParam }), controller.endClass);
router.post('/:id/cancel', requireAdmin, validate({ params: idParam }), controller.cancelClass);

router.get('/:id/attendance', requireAdmin, validate({ params: idParam }), attendance.classAttendance);
router.get('/:id/live-attendance', requireAdmin, validate({ params: idParam }), attendance.liveAttendance);
router.post('/:id/recompute', requireAdmin, validate({ params: idParam }), attendance.recompute);

export const classRoutes = router;
