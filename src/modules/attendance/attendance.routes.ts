import { Router } from 'express';
import { authenticate, requireAdmin, requireStudent } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { idParam } from '@/modules/shared/common.validation';
import * as controller from '@/modules/attendance/attendance.controller';
import {
  myAttendanceQuery,
  overrideAttendanceSchema,
} from '@/modules/attendance/attendance.validation';

const router = Router();

router.use(authenticate);

router.get('/me', requireStudent, validate({ query: myAttendanceQuery }), controller.myAttendance);

router.patch(
  '/:id/override',
  requireAdmin,
  validate({ params: idParam, body: overrideAttendanceSchema }),
  controller.overrideAttendance,
);

export const attendanceRoutes = router;
