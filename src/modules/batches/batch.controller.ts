import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import { asyncHandler } from '@/utils/asyncHandler';
import { param } from '@/utils/params';
import { buildMeta, sendResponse } from '@/utils/sendResponse';
import { assertBatchAccess } from '@/middleware/auth';
import { skipOf } from '@/modules/shared/common.validation';
import { Batch } from '@/models/batch.model';
import { ClassSession } from '@/models/classSession.model';
import { User } from '@/models/user.model';
import { notFound } from '@/utils/AppError';

/* ====================== for the implementing agent ======================= */

/**
 * POST /api/v1/batches  (admin)
 *
 * TODO(agent): create a batch.
 *
 * Contract:
 *  - Body validated by `createBatchSchema`. `code` arrives already uppercased.
 *  - Set `createdBy: req.user.id`.
 *  - A duplicate `code` surfaces as Mongo error 11000, which the error
 *    middleware already turns into a 409 — do not pre-check it.
 *  - 201 with the created document.
 */
export const createBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.create({
    ...req.body,
    createdBy: req.user!.id,
  });

  sendResponse(res, { statusCode: StatusCodes.CREATED, data: batch });
});

/**
 * GET /api/v1/batches  (admin)
 *
 * TODO(agent): paginated batch list.
 *
 * Contract:
 *  - Optional `status` filter; optional `search` matching `code` OR `title`
 *    case-insensitively — escape the search string before building the RegExp
 *    so a user-supplied `(` cannot throw.
 *  - Sort `createdAt: -1`.
 *  - Add a `studentCount` per row: one `User.aggregate` grouping
 *    `{ batch: { $in: ids }, role: 'student', status: 'verified' }` by batch,
 *    then merge onto the rows. Do NOT run a countDocuments per row.
 *  - `sendResponse(res, { data: rows, meta: buildMeta(...) })`.
 */
export const listBatches = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query as unknown as {
    page: number;
    limit: number;
    status?: 'active' | 'archived';
    search?: string;
  };

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ code: new RegExp(safe, 'i') }, { title: new RegExp(safe, 'i') }];
  }

  const [rows, total] = await Promise.all([
    Batch.find(filter).sort({ createdAt: -1 }).skip(skipOf({ page, limit })).limit(limit).lean(),
    Batch.countDocuments(filter),
  ]);

  const ids = rows.map((row) => row._id);
  const counts = ids.length
    ? await User.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { batch: { $in: ids }, role: 'student', status: 'verified' } },
        { $group: { _id: '$batch', count: { $sum: 1 } } },
      ])
    : [];

  const countByBatch = new Map(counts.map((c) => [String(c._id), c.count]));

  const data = rows.map((row) => ({
    ...row,
    studentCount: countByBatch.get(String(row._id)) ?? 0,
  }));

  sendResponse(res, { data, meta: buildMeta(page, limit, total) });
});

/**
 * GET /api/v1/batches/:id
 *
 * TODO(agent): one batch, readable by its own students too.
 *
 * Contract:
 *  - `assertBatchAccess(req, id)` first — the guard below is not optional.
 *  - Include `studentCount` (verified students) and `upcomingClassCount`
 *    (status 'scheduled' with scheduledStartAt >= now).
 */
export const getBatch = asyncHandler(async (req, res) => {
  const id = param(req, 'id');
  assertBatchAccess(req, id);

  const batch = await Batch.findById(id).lean();
  if (!batch) throw notFound('Batch');

  const [studentCount, upcomingClassCount] = await Promise.all([
    User.countDocuments({ batch: batch._id, role: 'student', status: 'verified' }),
    ClassSession.countDocuments({
      batch: batch._id,
      status: 'scheduled',
      scheduledStartAt: { $gte: new Date() },
    }),
  ]);

  sendResponse(res, { data: { ...batch, studentCount, upcomingClassCount } });
});

/**
 * PATCH /api/v1/batches/:id  (admin)
 *
 * TODO(agent): update title/description/dates/status. `code` is immutable —
 * students have already been told the code, and the schema omits it.
 */
export const updateBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findByIdAndUpdate(param(req, 'id'), req.body, {
    new: true,
    runValidators: true,
  }).lean();

  if (!batch) throw notFound('Batch');

  sendResponse(res, { data: batch });
});

/**
 * GET /api/v1/batches/:id/students
 *
 * TODO(agent): the batch roster.
 *
 * Contract:
 *  - `assertBatchAccess(req, id)` first.
 *  - Students see only verified members, and only { id, name } — a classmate
 *    must not be able to read everyone's email and phone number.
 *  - Admins see every status, with { id, name, email, phone, status, createdAt }.
 *    Branch on `req.user.role`.
 *  - Sort by `name: 1`.
 */
export const listBatchStudents = asyncHandler(async (req, res) => {
  const id = param(req, 'id');
  assertBatchAccess(req, id);

  const isAdmin = req.user!.role === 'admin';

  const filter: Record<string, unknown> = { batch: id, role: 'student' };
  if (!isAdmin) filter.status = 'verified';

  const students = await User.find(filter)
    .select(isAdmin ? 'name email phone status createdAt' : 'name')
    .sort({ name: 1 })
    .lean();

  const data = students.map((s) =>
    isAdmin
      ? {
          id: String(s._id),
          name: s.name,
          email: s.email,
          phone: s.phone,
          status: s.status,
          createdAt: s.createdAt,
        }
      : { id: String(s._id), name: s.name },
  );

  sendResponse(res, { data });
});
