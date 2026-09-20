import { Router } from 'express';
import { authenticate, requireAdmin } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { idParam } from '@/modules/shared/common.validation';
import * as controller from '@/modules/admin/adminUser.controller';
import {
  createAdminSchema,
  listUsersQuery,
  rejectUserSchema,
  suspendUserSchema,
  verifyUserSchema,
} from '@/modules/admin/admin.validation';

const router = Router();

router.use(authenticate, requireAdmin);

router.get('/overview', controller.overview);

router.get('/users', validate({ query: listUsersQuery }), controller.listUsers);
router.post('/users', validate({ body: createAdminSchema }), controller.createAdmin);

router.patch(
  '/users/:id/verify',
  validate({ params: idParam, body: verifyUserSchema }),
  controller.verifyUser,
);
router.patch(
  '/users/:id/reject',
  validate({ params: idParam, body: rejectUserSchema }),
  controller.rejectUser,
);
router.patch(
  '/users/:id/suspend',
  validate({ params: idParam, body: suspendUserSchema }),
  controller.suspendUser,
);

export const adminRoutes = router;
