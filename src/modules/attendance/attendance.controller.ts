import mongoose, { type Types } from 'mongoose';
import { asyncHandler } from '@/utils/asyncHandler';
import { param } from '@/utils/params';
import { buildMeta, sendResponse } from '@/utils/sendResponse';
import { assertBatchAccess } from '@/middleware/auth';
import { skipOf } from '@/modules/shared/common.validation';
import { AttendanceRecord } from '@/models/attendance.model';
import { ClassSession } from '@/models/classSession.model';
import { AuditLog } from '@/models/auditLog.model';
import { badRequest, notFound } from '@/utils/AppError';
import {
  livePresenceSnapshot,
  recomputeClassSession,
  touchHeartbeat,
} from '@/modules/attendance/attendance.engine';

/* ========================= implemented ================================== */

/**
 * POST /api/v1/classes/:id/heartbeat
 *
 * Called by the student's browser every 30 seconds while they are in the room.
 *
 * This does NOT feed attendance. Attendance comes from LiveKit's server-side
 * presence events precisely because anything the browser reports can be
 * forged. The heartbeat only powers the admin's "who is online right now"
 * indicator, and stopping it costs a student nothing.
 */
export const heartbeat = asyncHandler(async (req, res) => {
  const cls = await ClassSession.findById(param(req, 'id')).select('batch status').lean();
  if (!cls) throw notFound('Class');
  assertBatchAccess(req, String(cls.batch));

  if (cls.status === 'live') await touchHeartbeat(cls._id, req.user!.id);

  sendResponse(res, { data: { acknowledged: true, classStatus: cls.status } });
});

/**
 * GET /api/v1/classes/:id/live-attendance  (admin)
 *
 * Presence as of this instant, computed but not stored. The admin panel polls
 * this every 10 seconds while a class runs.
 */
export const liveAttendance = asyncHandler(async (req, res) => {
  const snapshot = await livePresenceSnapshot(param(req, 'id'));
  sendResponse(res, { data: snapshot });
});

/**
 * PATCH /api/v1/attendance/:id/override  (admin)
 *
 * Manually sets a student's result — the escape hatch for the student whose
 * internet died twenty minutes in. The computed numbers are left untouched
 * beside the override so the original evidence survives the correction.
 */
export const overrideAttendance = asyncHandler(async (req, res) => {
  const record = await AttendanceRecord.findById(param(req, 'id'));
  if (!record) throw notFound('Attendance record');

  record.override = {
    status: req.body.status,
    reason: req.body.reason,
    by: req.user!.id as unknown as typeof record.student,
    at: new Date(),
  };
  record.status = req.body.status;
  await record.save();

  await AuditLog.create({
    actor: req.user!.id,
    action: 'attendance.override',
    targetType: 'AttendanceRecord',
    targetId: record._id,
    meta: {
      student: String(record.student),
      to: req.body.status,
      computedPct: record.presencePct,
      reason: req.body.reason,
    },
  });

  sendResponse(res, { message: 'Attendance updated.', data: record });
});

/**
 * POST /api/v1/classes/:id/recompute  (admin)
 *
 * Re-runs the engine over a finished class. Needed after correcting a class's
 * actual start or end time — an admin who forgot to press "End" leaves an
 * inflated denominator that drags everyone below the threshold.
 */
export const recompute = asyncHandler(async (req, res) => {
  const cls = await ClassSession.findById(param(req, 'id')).lean();
  if (!cls) throw notFound('Class');
  if (cls.status !== 'ended') {
    throw badRequest('Only a finished class can be recomputed.', 'CLASS_NOT_ENDED');
  }

  const result = await recomputeClassSession(cls._id);

  await AuditLog.create({
    actor: req.user!.id,
    action: 'attendance.recompute',
    targetType: 'ClassSession',
    targetId: cls._id,
    meta: result as unknown as Record<string, unknown>,
  });

  sendResponse(res, { message: 'Attendance recomputed.', data: result });
});

/* ====================== for the implementing agent ======================= */

/**
 * GET /api/v1/classes/:id/attendance  (admin)
 *
 * TODO(agent): the per-class attendance sheet.
 *
 * Contract:
 *  - Find the class; `notFound('Class')` if missing.
 *  - `AttendanceRecord.find({ classSession: id })`, `.populate('student', 'name email phone')`,
 *    `.sort({ presencePct: -1 })`, `.lean()`.
 *  - Shape each row as:
 *      { id, student: { id, name, email, phone }, totalPresentMs, presencePct,
 *        status, firstJoinedAt, lastLeftAt, segmentCount: segments.length,
 *        overridden: Boolean(override) }
 *  - Respond with:
 *      { classSession: { id, title, actualStartAt, actualEndAt, durationMs,
 *                        attendanceThresholdPct, status },
 *        rows: [...],
 *        summary: { enrolled, joined, present, partial, absent, avgPresencePct } }
 *    where durationMs is actualEndAt - actualStartAt (0 when either is null),
 *    and the summary counts are derived from `rows`.
 *  - No pagination: a batch is one classroom's worth of students.
 */
export const classAttendance = asyncHandler(async (req, res) => {
  const cls = await ClassSession.findById(param(req, 'id')).lean();
  if (!cls) throw notFound('Class');

  const records = await AttendanceRecord.find({ classSession: cls._id })
    .populate<{ student: { _id: Types.ObjectId; name: string; email: string; phone: string } }>(
      'student',
      'name email phone',
    )
    .sort({ presencePct: -1 })
    .lean();

  const rows = records.map((rec) => ({
    id: String(rec._id),
    student: {
      id: String(rec.student._id),
      name: rec.student.name,
      email: rec.student.email,
      phone: rec.student.phone,
    },
    totalPresentMs: rec.totalPresentMs,
    presencePct: rec.presencePct,
    status: rec.status,
    firstJoinedAt: rec.firstJoinedAt,
    lastLeftAt: rec.lastLeftAt,
    segmentCount: rec.segments.length,
    overridden: Boolean(rec.override),
  }));

  const present = rows.filter((r) => r.status === 'present').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const absent = rows.filter((r) => r.status === 'absent').length;
  const joined = rows.filter((r) => r.segmentCount > 0).length;
  const pctSum = rows.reduce((sum, r) => sum + r.presencePct, 0);

  const durationMs =
    cls.actualStartAt && cls.actualEndAt
      ? cls.actualEndAt.getTime() - cls.actualStartAt.getTime()
      : 0;

  sendResponse(res, {
    data: {
      classSession: {
        id: String(cls._id),
        title: cls.title,
        actualStartAt: cls.actualStartAt,
        actualEndAt: cls.actualEndAt,
        durationMs,
        attendanceThresholdPct: cls.attendanceThresholdPct,
        status: cls.status,
      },
      rows,
      summary: {
        enrolled: rows.length,
        joined,
        present,
        partial,
        absent,
        avgPresencePct: rows.length ? Math.round((pctSum / rows.length) * 100) / 100 : 0,
      },
    },
  });
});

/**
 * GET /api/v1/attendance/me
 *
 * TODO(agent): the signed-in student's own attendance history.
 *
 * Contract:
 *  - Filter `{ student: req.user.id }`, restricted to classes that have been
 *    finalized: look up records whose `finalizedAt` is not null.
 *  - Populate `classSession` with 'title scheduledStartAt actualStartAt actualEndAt status'.
 *  - Sort by the class's scheduledStartAt descending. (Populate cannot sort, so
 *    sort the lean result in JS after fetching, or sort by `createdAt: -1`,
 *    which is equivalent here because records are created when a class starts.)
 *  - Paginate with `skipOf(req.query)` / `buildMeta`.
 *  - Also return an `overall` block:
 *      { totalClasses, attended, attendanceRate }  where attended counts
 *      status === 'present' and attendanceRate is a 2dp percentage.
 *    Compute `overall` across ALL of the student's finalized records, not just
 *    the current page.
 */
export const myAttendance = asyncHandler(async (req, res) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const baseFilter = { student: req.user!.id, finalizedAt: { $ne: null } };

  const [records, total, attended] = await Promise.all([
    AttendanceRecord.find(baseFilter)
      .populate<{
        classSession: {
          _id: Types.ObjectId;
          title: string;
          scheduledStartAt: Date;
          actualStartAt: Date | null;
          actualEndAt: Date | null;
          status: string;
          attendanceThresholdPct: number;
        };
      }>(
        'classSession',
        'title scheduledStartAt actualStartAt actualEndAt status attendanceThresholdPct',
      )
      // Sorted at the database level, before skip/limit — a class's record is
      // created when that class starts, so `createdAt` tracks scheduledStartAt
      // order. Sorting only the fetched page (after skip/limit) would leave the
      // pagination boundary itself unordered: two pages could overlap or skip
      // records, because Mongo's skip/limit has no defined order without a sort.
      .sort({ createdAt: -1 })
      .skip(skipOf({ page, limit }))
      .limit(limit)
      .lean(),
    AttendanceRecord.countDocuments(baseFilter),
    AttendanceRecord.countDocuments({ ...baseFilter, status: 'present' }),
  ]);

  const data = records.map((rec) => ({
    id: String(rec._id),
    classSession: {
      id: String(rec.classSession._id),
      title: rec.classSession.title,
      scheduledStartAt: rec.classSession.scheduledStartAt,
      actualStartAt: rec.classSession.actualStartAt,
      actualEndAt: rec.classSession.actualEndAt,
      status: rec.classSession.status,
      attendanceThresholdPct: rec.classSession.attendanceThresholdPct,
    },
    totalPresentMs: rec.totalPresentMs,
    presencePct: rec.presencePct,
    status: rec.status,
  }));

  const attendanceRate = total ? Math.round((attended / total) * 10_000) / 100 : 0;

  sendResponse(res, {
    data,
    meta: buildMeta(page, limit, total),
    overall: { totalClasses: total, attended, attendanceRate },
  });
});

/**
 * GET /api/v1/batches/:id/analytics  (admin)
 *
 * TODO(agent): batch-wide attendance analytics.
 *
 * Contract — return three blocks.
 *
 *  1. `perStudent`: one row per verified student in the batch:
 *       { studentId, name, email, classesHeld, attended, attendanceRate, avgPresencePct }
 *     Aggregation on AttendanceRecord:
 *       [ { $match: { batch: new mongoose.Types.ObjectId(id), finalizedAt: { $ne: null } } },
 *         { $group: { _id: '$student',
 *                     classesHeld: { $sum: 1 },
 *                     attended: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
 *                     avgPresencePct: { $avg: '$presencePct' } } },
 *         { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'student' } },
 *         { $unwind: '$student' },
 *         { $project: { _id: 0, studentId: '$_id', name: '$student.name',
 *                       email: '$student.email', classesHeld: 1, attended: 1,
 *                       avgPresencePct: { $round: ['$avgPresencePct', 2] },
 *                       attendanceRate: { $round: [ { $multiply: [ { $divide: ['$attended', '$classesHeld'] }, 100 ] }, 2 ] } } },
 *         { $sort: { attendanceRate: -1 } } ]
 *
 *  2. `perClass`: one row per finalized class of the batch, newest first:
 *       { classId, title, date: actualStartAt, durationMin, enrolled, present, attendanceRate }
 *     Read this straight off `ClassSession.stats`, which the engine already
 *     wrote at finalize — do not recompute it from AttendanceRecord.
 *     Filter `{ batch: id, status: 'ended', attendanceFinalizedAt: { $ne: null } }`.
 *
 *  3. `summary`: { totalClasses, totalStudents, overallAttendanceRate }
 *     `overallAttendanceRate` = present records / total finalized records * 100, 2dp.
 *
 *  Accept optional `from`/`to` query dates (validated by `batchAnalyticsQuery`)
 *  and, when present, constrain the classes considered to that window via
 *  `actualStartAt`. For `perStudent` that means first collecting the matching
 *  class ids and adding `classSession: { $in: ids }` to the `$match`.
 */
export const batchAnalytics = asyncHandler(async (req, res) => {
  const id = param(req, 'id');
  assertBatchAccess(req, id);

  const { from, to } = req.query as unknown as { from?: Date; to?: Date };

  const classFilter: Record<string, unknown> = {
    batch: new mongoose.Types.ObjectId(id),
    status: 'ended',
    attendanceFinalizedAt: { $ne: null },
  };
  if (from || to) {
    const window: Record<string, Date> = {};
    if (from) window.$gte = from;
    if (to) window.$lte = to;
    classFilter.actualStartAt = window;
  }

  const classes = await ClassSession.find(classFilter).sort({ actualStartAt: -1 }).lean();
  const classIds = classes.map((c) => c._id);

  const perStudentMatch: Record<string, unknown> = {
    batch: new mongoose.Types.ObjectId(id),
    finalizedAt: { $ne: null },
  };
  if (classIds.length > 0) perStudentMatch.classSession = { $in: classIds };

  const perStudent = await AttendanceRecord.aggregate<{
    studentId: Types.ObjectId;
    name: string;
    email: string;
    classesHeld: number;
    attended: number;
    avgPresencePct: number;
    attendanceRate: number;
  }>([
    { $match: perStudentMatch },
    {
      $group: {
        _id: '$student',
        classesHeld: { $sum: 1 },
        attended: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        avgPresencePct: { $avg: '$presencePct' },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    {
      $project: {
        _id: 0,
        studentId: '$_id',
        name: '$student.name',
        email: '$student.email',
        classesHeld: 1,
        attended: 1,
        avgPresencePct: { $round: ['$avgPresencePct', 2] },
        attendanceRate: {
          $round: [{ $multiply: [{ $divide: ['$attended', '$classesHeld'] }, 100] }, 2],
        },
      },
    },
    { $sort: { attendanceRate: -1 } },
  ]);

  const perClass = classes.map((cls) => {
    const enrolled = cls.stats?.enrolledCount ?? 0;
    const present = cls.stats?.presentCount ?? 0;

    // The actual minutes the class ran, not the scheduled length — consistent
    // with how the attendance engine itself scores presence. Falls back to the
    // scheduled figure only in the unreachable case of a missing timestamp.
    const durationMin =
      cls.actualStartAt && cls.actualEndAt
        ? Math.round((cls.actualEndAt.getTime() - cls.actualStartAt.getTime()) / 60_000)
        : cls.scheduledDurationMin;

    return {
      classId: String(cls._id),
      title: cls.title,
      date: cls.actualStartAt,
      durationMin,
      enrolled,
      present,
      attendanceRate: enrolled ? Math.round((present / enrolled) * 10_000) / 100 : 0,
      // Per-class, because an admin may set a different bar for a different
      // class — a constant on the client would silently ignore that override.
      attendanceThresholdPct: cls.attendanceThresholdPct,
    };
  });

  const totalRecords = perStudent.reduce((sum, row) => sum + row.classesHeld, 0);
  const presentRecords = perStudent.reduce((sum, row) => sum + row.attended, 0);

  sendResponse(res, {
    data: {
      perStudent: perStudent.map((row) => ({ ...row, studentId: String(row.studentId) })),
      perClass,
      summary: {
        totalClasses: perClass.length,
        totalStudents: perStudent.length,
        overallAttendanceRate: totalRecords
          ? Math.round((presentRecords / totalRecords) * 10_000) / 100
          : 0,
      },
    },
  });
});
