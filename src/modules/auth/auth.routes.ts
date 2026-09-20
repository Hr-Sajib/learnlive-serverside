import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authenticate } from '@/middleware/auth';
import { authLimiter } from '@/middleware/rateLimit';
import * as controller from '@/modules/auth/auth.controller';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
} from '@/modules/auth/auth.validation';

const router = Router();

router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);
router.patch(
  '/password',
  authenticate,
  authLimiter,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

export const authRoutes = router;
