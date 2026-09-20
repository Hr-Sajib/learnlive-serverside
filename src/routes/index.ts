import { Router } from 'express';
import { authRoutes } from '@/modules/auth/auth.routes';
import { batchRoutes } from '@/modules/batches/batch.routes';
import { classRoutes } from '@/modules/classes/class.routes';
import { attendanceRoutes } from '@/modules/attendance/attendance.routes';
import { adminRoutes } from '@/modules/admin/admin.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/batches', batchRoutes);
router.use('/classes', classRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/admin', adminRoutes);

export const apiRoutes = router;
