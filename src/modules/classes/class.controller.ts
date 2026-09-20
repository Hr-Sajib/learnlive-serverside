import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '@/utils/asyncHandler';
import { param } from '@/utils/params';
import { buildMeta, sendResponse } from '@/utils/sendResponse';
import { assertBatchAccess } from '@/middleware/auth';
import { skipOf } from '@/modules/shared/common.validation';
import { ClassSession } from '@/models/classSession.model';
import { AuditLog } from '@/models/auditLog.model';
import { conflict, notFound } from '@/utils/AppError';
import * as classService from '@/modules/classes/class.service';

/* ========================= implemented: lifecycle ========================= */

export const createClass = asyncHandler(async (req, res) => {
  const cls = await classService.createClass(req.body, req.user!.id);
  await AuditLog.create({
    actor: req.user!.id,
    action: 'class.create',
    targetType: 'ClassSession',
    targetId: cls._id,
    meta: { title: cls.title },
  });
  sendResponse(res, { statusCode: StatusCodes.CREATED, message: 'Class scheduled.', data: cls });
});

export const startClass = asyncHandler(async (req, res) => {
  const cls = await classService.startClass(param(req, 'id'), req.user!.id);
  await AuditLog.create({
    actor: req.user!.id,
    action: 'class.start',
    targetType: 'ClassSession',
    targetId: cls._id,
    meta: { actualStartAt: cls.actualStartAt },
  });
  sendResponse(res, { message: 'Class is live. Students can join now.', data: cls });
});

export const endClass = asyncHandler(async (req, res) => {
  const result = await classService.endClass(param(req, 'id'));
  await AuditLog.create({
    actor: req.user!.id,
    action: 'class.end',
    targetType: 'ClassSession',
    targetId: param(req, 'id'),
    meta: result as unknown as Record<string, unknown>,
  });
  sendResponse(res, {
    message: `Class ended. ${result.presentCount} of ${result.enrolledCount} students met the attendance threshold.`,
    data: result,
  });
});

export const cancelClass = asyncHandler(async (req, res) => {
  const cls = await classService.cancelClass(param(req, 'id'));
  sendResponse(res, { message: 'Class cancelled.', data: cls });
});

/**
 * Students and the host both call this to enter the room. It is the only
 * place a LiveKit credential is created; see `issueJoinToken` for the gate.
 */
export const joinClass = asyncHandler(async (req, res) => {
  const grant = await classService.issueJoinToken(param(req, 'id'), req.user!);
  sendResponse(res, { data: grant });
});

/* ====================== for the implementing agent ======================= */

/**
 * GET /api/v1/classes
 *
 * TODO(agent): list classes with pagination.
 *
 * Contract:
 *  - `req.query` is already validated by `listClassesQuery` -> { page, limit, batchId?, status? }.
 *  - Students may only ever see their own batch. Force `filter.batch = req.user.batchId`
 *    for role 'student', ignoring any `batchId` they passed. Admins may filter freely.
 *  - Sort by `scheduledStartAt: -1`.
 *  - Populate `batch` with 'code title'.
 *  - Respond with `sendResponse(res, { data: rows, meta: buildMeta(page, limit, total) })`.
 *  - Use `skipOf(req.query)` from '@/modules/shared/common.validation' for the offset.
 */
export const listClasses = asyncHandler(async (req, res) => {
  const { page, limit, batchId, status } = req.query as unknown as {
    page: number;
    limit: number;
    batchId?: string;
    status?: string;
  };

  const filter: Record<string, unknown> = {};
  if (req.user!.role === 'student') {
    filter.batch = req.user!.batchId;
  } else if (batchId) {
    filter.batch = batchId;
  }
  if (status) filter.status = status;

  const [rows, total] = await Promise.all([
    ClassSession.find(filter)
      .populate('batch', 'code title')
      .sort({ scheduledStartAt: -1 })
      .skip(skipOf({ page, limit }))
      .limit(limit)
      .lean(),
    ClassSession.countDocuments(filter),
  ]);

  sendResponse(res, { data: rows, meta: buildMeta(page, limit, total) });
});

/**
 * GET /api/v1/classes/:id
 *
 * TODO(agent): return one class.
 *
 * Contract:
 *  - 404 via `notFound('Class')` when missing.
 *  - Call `assertBatchAccess(req, String(cls.batch))` before returning it — without
 *    this a student could read another batch's timetable by guessing an id.
 *  - Populate `batch` with 'code title' and `host` with 'name'.
 */
export const getClass = asyncHandler(async (req, res) => {
  const cls = await ClassSession.findById(param(req, 'id'));
  if (!cls) throw notFound('Class');
  assertBatchAccess(req, String(cls.batch));

  await cls.populate([
    { path: 'batch', select: 'code title' },
    { path: 'host', select: 'name' },
  ]);

  sendResponse(res, { data: cls });
});

/**
 * PATCH /api/v1/classes/:id
 *
 * TODO(agent): update a scheduled class (admin only).
 *
 * Contract:
 *  - Only a class with status 'scheduled' may be edited. For any other status
 *    throw `conflict('A live or finished class cannot be edited.', 'INVALID_TRANSITION')`.
 *  - Body is validated by `updateClassSchema`; apply it with `$set`.
 *  - Never let the body change `batch`, `roomName`, `status`, `actualStartAt`,
 *    `actualEndAt` or `stats` — the schema already omits them, so pass `req.body` straight through.
 */
export const updateClass = asyncHandler(async (req, res) => {
  const cls = await ClassSession.findOneAndUpdate(
    { _id: param(req, 'id'), status: 'scheduled' },
    { $set: req.body },
    { new: true, runValidators: true },
  ).lean();

  if (!cls) {
    const existing = await ClassSession.findById(param(req, 'id')).lean();
    if (!existing) throw notFound('Class');
    throw conflict('A live or finished class cannot be edited.', 'INVALID_TRANSITION');
  }

  sendResponse(res, { data: cls });
});
