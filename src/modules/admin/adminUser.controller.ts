import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '@/utils/asyncHandler';
import { buildMeta, sendResponse } from '@/utils/sendResponse';
import { Batch } from '@/models/batch.model';
import { ClassSession } from '@/models/classSession.model';
import { Session } from '@/models/session.model';
import { User } from '@/models/user.model';
import { AuditLog } from '@/models/auditLog.model';
import { badRequest, conflict, notFound } from '@/utils/AppError';
import { skipOf } from '@/modules/shared/common.validation';
import { hashPassword } from '@/modules/auth/auth.service';

/**
 * Admin verification — the gate between "someone filled in a form" and
 * "a member of this batch community".
 *
 * Every transition here is guarded on the status it expects to find, so two
 * admins working the queue at the same time cannot both approve the same
 * person, and an approval cannot silently undo a rejection made a second earlier.
 */

/* ========================= implemented ================================== */

/**
 * GET /api/v1/admin/users
 *
 * The approval queue. Defaults to `status=pending` because that is what an
 * admin opens this screen to do.
 */
export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, status, batchId, search } = req.query as unknown as {
    page: number;
    limit: number;
    status?: string;
    batchId?: string;
    search?: string;
  };

  const filter: Record<string, unknown> = { role: 'student' };
  if (status) filter.status = status;
  if (batchId) filter.batch = batchId;
  if (search) {
    // Escaped so a stray "(" in the search box cannot throw a RegExp error.
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }

  const [rows, total] = await Promise.all([
    User.find(filter)
      .select('name email phone status batch requestedBatchCode createdAt verifiedAt rejectionReason')
      .populate('batch', 'code title')
      .sort({ createdAt: -1 })
      .skip(skipOf({ page, limit }))
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  sendResponse(res, { data: rows, meta: buildMeta(page, limit, total) });
});

/**
 * PATCH /api/v1/admin/users/:id/verify
 *
 * Approves a pending registration. An admin may redirect the student to a
 * different batch than the code they typed — people mistype batch codes, and
 * making the admin reject and re-register them would be absurd.
 */
export const verifyUser = asyncHandler(async (req, res) => {
  const { batchId } = (req.body ?? {}) as { batchId?: string };

  const target = await User.findById(req.params.id).lean();
  if (!target) throw notFound('User');
  if (target.role !== 'student') throw badRequest('Only student accounts are verified.', 'NOT_A_STUDENT');
  if (target.status === 'verified') throw conflict('That account is already verified.', 'ALREADY_VERIFIED');

  const finalBatchId = batchId ?? (target.batch ? String(target.batch) : null);
  if (!finalBatchId) {
    throw badRequest(
      'This account has no batch. Choose the batch to place them in before verifying.',
      'BATCH_REQUIRED',
    );
  }

  const batch = await Batch.findById(finalBatchId).lean();
  if (!batch) throw notFound('Batch');

  // Guarded on the current status so two admins cannot both claim the approval.
  const user = await User.findOneAndUpdate(
    { _id: target._id, status: { $in: ['pending', 'rejected', 'suspended'] } },
    {
      $set: {
        status: 'verified',
        batch: batch._id,
        verifiedAt: new Date(),
        verifiedBy: req.user!.id,
        rejectionReason: null,
      },
    },
    { new: true },
  );

  if (!user) throw conflict('That account was just updated by someone else. Refresh and try again.', 'STALE_WRITE');

  await AuditLog.create({
    actor: req.user!.id,
    action: 'user.verify',
    targetType: 'User',
    targetId: user._id,
    meta: { batch: batch.code, movedBatch: Boolean(batchId && String(target.batch) !== batchId) },
  });

  sendResponse(res, {
    message: `${user.name} can now sign in and join ${batch.code} classes.`,
    data: user,
  });
});

/**
 * PATCH /api/v1/admin/users/:id/reject
 *
 * The reason is required and is shown to the student on their next sign-in
 * attempt, so "you were declined" is never a dead end.
 */
export const rejectUser = asyncHandler(async (req, res) => {
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'student', status: 'pending' },
    { $set: { status: 'rejected', rejectionReason: req.body.reason, verifiedBy: req.user!.id } },
    { new: true },
  );

  if (!user) {
    const existing = await User.findById(req.params.id).lean();
    if (!existing) throw notFound('User');
    throw conflict(`A ${existing.status} account cannot be rejected.`, 'INVALID_TRANSITION');
  }

  await AuditLog.create({
    actor: req.user!.id,
    action: 'user.reject',
    targetType: 'User',
    targetId: user._id,
    meta: { reason: req.body.reason },
  });

  sendResponse(res, { message: 'Registration declined.', data: user });
});

/**
 * PATCH /api/v1/admin/users/:id/suspend
 *
 * Kills every live session as well as the flag. Leaving the sessions alive
 * would let a suspended student keep using their existing cookie for another
 * fifteen minutes — including to walk into a live class.
 */
export const suspendUser = asyncHandler(async (req, res) => {
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: 'student', status: 'verified' },
    { $set: { status: 'suspended', rejectionReason: req.body?.reason ?? null } },
    { new: true },
  );

  if (!user) {
    const existing = await User.findById(req.params.id).lean();
    if (!existing) throw notFound('User');
    throw conflict(`A ${existing.status} account cannot be suspended.`, 'INVALID_TRANSITION');
  }

  await Session.deleteMany({ user: user._id });

  await AuditLog.create({
    actor: req.user!.id,
    action: 'user.suspend',
    targetType: 'User',
    targetId: user._id,
    meta: { reason: req.body?.reason ?? null },
  });

  sendResponse(res, { message: `${user.name} has been suspended.`, data: user });
});

/* ====================== for the implementing agent ======================= */

/**
 * GET /api/v1/admin/overview
 *
 * TODO(agent): the admin dashboard header numbers.
 *
 * Contract — return exactly this shape, in ONE `Promise.all`:
 *   {
 *     pendingVerifications: User.countDocuments({ role: 'student', status: 'pending' }),
 *     verifiedStudents:     User.countDocuments({ role: 'student', status: 'verified' }),
 *     activeBatches:        Batch.countDocuments({ status: 'active' }),
 *     liveClasses:          ClassSession.countDocuments({ status: 'live' }),
 *     upcomingClasses:      ClassSession.countDocuments({ status: 'scheduled', scheduledStartAt: { $gte: new Date() } }),
 *     recentClasses:        ClassSession.find({ status: 'ended' })
 *                             .sort({ actualEndAt: -1 }).limit(5)
 *                             .select('title batch actualStartAt actualEndAt stats')
 *                             .populate('batch', 'code').lean(),
 *   }
 */
export const overview = asyncHandler(async (_req, res) => {
  const [
    pendingVerifications,
    verifiedStudents,
    activeBatches,
    liveClasses,
    upcomingClasses,
    recentClasses,
  ] = await Promise.all([
    User.countDocuments({ role: 'student', status: 'pending' }),
    User.countDocuments({ role: 'student', status: 'verified' }),
    Batch.countDocuments({ status: 'active' }),
    ClassSession.countDocuments({ status: 'live' }),
    ClassSession.countDocuments({ status: 'scheduled', scheduledStartAt: { $gte: new Date() } }),
    ClassSession.find({ status: 'ended' })
      .sort({ actualEndAt: -1 })
      .limit(5)
      .select('title batch actualStartAt actualEndAt stats')
      .populate('batch', 'code')
      .lean(),
  ]);

  sendResponse(res, {
    data: {
      pendingVerifications,
      verifiedStudents,
      activeBatches,
      liveClasses,
      upcomingClasses,
      recentClasses,
    },
  });
});

/**
 * POST /api/v1/admin/users  (admin)
 *
 * TODO(agent): create another admin account directly (no verification step).
 *
 * Contract:
 *  - Body validated by `createAdminSchema`.
 *  - `passwordHash: await hashPassword(body.password)` from '@/modules/auth/auth.service'.
 *  - `role: 'admin'`, `status: 'verified'`, `batch: null`.
 *  - 201 with the user, and write an `admin.create` AuditLog entry.
 */
export const createAdmin = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body as {
    name: string;
    email: string;
    phone: string;
    password: string;
  };

  const user = await User.create({
    name,
    email,
    phone,
    passwordHash: await hashPassword(password),
    role: 'admin',
    status: 'verified',
    batch: null,
  });

  await AuditLog.create({
    actor: req.user!.id,
    action: 'admin.create',
    targetType: 'User',
    targetId: user._id,
    meta: { name: user.name, email: user.email },
  });

  const { passwordHash, ...publicUser } = user.toObject();

  sendResponse(res, { statusCode: StatusCodes.CREATED, data: publicUser });
});
