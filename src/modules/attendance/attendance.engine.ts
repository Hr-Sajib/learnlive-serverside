import type { Types } from 'mongoose';
import { AttendanceRecord, type AttendanceStatus, type IPresenceSegment, type PresenceSource } from '@/models/attendance.model';
import { ClassSession } from '@/models/classSession.model';
import { User } from '@/models/user.model';
import { logger } from '@/lib/logger';
import { notFound } from '@/utils/AppError';

/**
 * ============================================================================
 * THE ATTENDANCE ENGINE
 * ============================================================================
 *
 * A student is marked present when their time inside the LiveKit room covers
 * at least `attendanceThresholdPct` (default 60) of the class's ACTUAL
 * duration — actualEndAt minus actualStartAt, not the scheduled length.
 * Scheduling for 90 minutes and running for 50 must not punish the students
 * who attended the whole 50.
 *
 * Presence comes from exactly one source of truth: LiveKit's server-side
 * participant events. It is never taken from the browser, because anything the
 * browser reports can be forged by a student who wants credit for a class they
 * did not sit through. The client heartbeat exists only to light up the
 * admin's live panel.
 *
 * Presence is recorded as SEGMENTS — a join time and a leave time. A student
 * who drops out and rejoins four times accumulates four segments, and their
 * credited time is the union of all of them.
 *
 * Two mechanisms write segments:
 *
 *   1. Webhooks (`participant_joined` / `participant_left`) — immediate, and
 *      how presence is normally tracked.
 *   2. The reconciliation sweep (`jobs/reconcilePresence.ts`) — every 60s it
 *      asks LiveKit who is actually in each live room and repairs the record.
 *      This exists because webhook delivery is best-effort: a dropped
 *      `participant_left` would otherwise leave a segment open forever and
 *      hand a student credit for a class they walked out of.
 *
 * Both are idempotent. Opening a segment when one is already open is a no-op;
 * closing when none is open is a no-op. That invariant — at most one open
 * segment per record — is what lets a duplicated or out-of-order webhook be
 * replayed safely, and it is enforced in the Mongo filters below rather than
 * in application logic, so two concurrent writers cannot both win.
 */

/** A class shorter than this is treated as not actually held. */
const MIN_CREDITABLE_DURATION_MS = 60_000;

export interface PresenceComputation {
  totalPresentMs: number;
  presencePct: number;
  status: AttendanceStatus;
}

/* -------------------------------------------------------------------------- */
/* Pure computation — no database. Unit-test this directly.                    */
/* -------------------------------------------------------------------------- */

/**
 * Clamps each segment to the class window, drops the ones that fall outside
 * it, and merges anything that overlaps.
 *
 * Clamping is what stops a student who idled in the room for 20 minutes before
 * the admin pressed "Start class" from banking that time. Merging is a
 * belt-and-braces guard: LiveKit enforces one connection per identity, but if
 * a duplicated webhook ever produced overlapping segments, the overlap must be
 * counted once, not twice.
 */
export function mergeSegments(
  segments: readonly IPresenceSegment[],
  windowStart: Date,
  windowEnd: Date,
): Array<{ start: number; end: number }> {
  const lo = windowStart.getTime();
  const hi = windowEnd.getTime();

  const clamped = segments
    .map((s) => ({
      start: Math.max(lo, s.joinedAt.getTime()),
      // An open segment at computation time is treated as running to the end
      // of the window. Finalization closes them first, so this only applies to
      // the live, in-progress view.
      end: Math.min(hi, (s.leftAt ?? windowEnd).getTime()),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const seg of clamped) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Turns a set of segments into a verdict.
 *
 * `partial` means "showed up but did not meet the bar". It is not attendance —
 * it exists so an admin looking at analytics can tell a student who sat
 * through 55% from one who never opened the link at all.
 */
export function computePresence(
  segments: readonly IPresenceSegment[],
  windowStart: Date,
  windowEnd: Date,
  thresholdPct: number,
): PresenceComputation {
  const durationMs = windowEnd.getTime() - windowStart.getTime();

  if (durationMs < MIN_CREDITABLE_DURATION_MS) {
    return { totalPresentMs: 0, presencePct: 0, status: 'absent' };
  }

  const merged = mergeSegments(segments, windowStart, windowEnd);
  const totalPresentMs = merged.reduce((sum, s) => sum + (s.end - s.start), 0);

  // Capped at 100: clamping already bounds it, but rounding must never print 100.01%.
  const presencePct = Math.min(100, Math.round((totalPresentMs / durationMs) * 10_000) / 100);

  const status: AttendanceStatus =
    presencePct >= thresholdPct ? 'present' : totalPresentMs > 0 ? 'partial' : 'absent';

  return { totalPresentMs, presencePct, status };
}

/* -------------------------------------------------------------------------- */
/* Segment writers — idempotent, concurrency-safe.                             */
/* -------------------------------------------------------------------------- */

/** Creates the record if this is the student's first contact with the class. */
export async function ensureRecord(
  classSessionId: Types.ObjectId | string,
  batchId: Types.ObjectId | string,
  studentId: Types.ObjectId | string,
): Promise<void> {
  await AttendanceRecord.updateOne(
    { classSession: classSessionId, student: studentId },
    { $setOnInsert: { classSession: classSessionId, batch: batchId, student: studentId, segments: [] } },
    { upsert: true },
  );
}

/**
 * Opens a presence segment.
 *
 * The filter `segments: { $not: { $elemMatch: { leftAt: null } } }` is the
 * whole idempotency guarantee: the push only lands when no segment is
 * currently open. A replayed `participant_joined` matches nothing and changes
 * nothing.
 */
export async function openSegment(
  classSessionId: Types.ObjectId | string,
  studentId: Types.ObjectId | string,
  at: Date,
  source: PresenceSource,
): Promise<boolean> {
  const res = await AttendanceRecord.updateOne(
    {
      classSession: classSessionId,
      student: studentId,
      segments: { $not: { $elemMatch: { leftAt: null } } },
    },
    { $push: { segments: { joinedAt: at, leftAt: null, openedBy: source, closedBy: null } } },
  );

  if (res.modifiedCount > 0) {
    // Separate write so the `firstJoinedAt` bookkeeping cannot fight the guard above.
    await AttendanceRecord.updateOne(
      { classSession: classSessionId, student: studentId, firstJoinedAt: null },
      { $set: { firstJoinedAt: at } },
    );
    return true;
  }
  return false;
}

/**
 * Closes the open presence segment, if there is one.
 *
 * The positional `segments.$` targets the first element matching
 * `segments.leftAt: null`. Because `openSegment` guarantees at most one open
 * segment exists, "the first open one" is always "the only open one".
 */
export async function closeSegment(
  classSessionId: Types.ObjectId | string,
  studentId: Types.ObjectId | string,
  at: Date,
  source: PresenceSource,
): Promise<boolean> {
  const res = await AttendanceRecord.updateOne(
    { classSession: classSessionId, student: studentId, 'segments.leftAt': null },
    { $set: { 'segments.$.leftAt': at, 'segments.$.closedBy': source, lastLeftAt: at } },
  );
  return res.modifiedCount > 0;
}

/** Records a client heartbeat. Display only — never an input to attendance. */
export async function touchHeartbeat(
  classSessionId: Types.ObjectId | string,
  studentId: Types.ObjectId | string,
): Promise<void> {
  await AttendanceRecord.updateOne(
    { classSession: classSessionId, student: studentId },
    { $set: { lastHeartbeatAt: new Date() } },
  );
}

/* -------------------------------------------------------------------------- */
/* Finalization                                                                */
/* -------------------------------------------------------------------------- */

export interface FinalizeResult {
  classSessionId: string;
  durationMs: number;
  enrolledCount: number;
  joinedCount: number;
  presentCount: number;
  avgPresencePct: number;
  alreadyFinalized: boolean;
}

/**
 * Computes and freezes attendance for a finished class.
 *
 * Runs at most once per class. The guarded `findOneAndUpdate` on
 * `attendanceFinalizedAt` is the claim: if an admin's "End class" and the
 * LiveKit `room_finished` webhook both fire, the first one through does the
 * work and the second returns `alreadyFinalized`.
 */
export async function finalizeClassSession(
  classSessionId: Types.ObjectId | string,
): Promise<FinalizeResult> {
  const claimedAt = new Date();

  // Claim finalization atomically so a concurrent caller cannot double-run it.
  const cls = await ClassSession.findOneAndUpdate(
    { _id: classSessionId, attendanceFinalizedAt: null },
    { $set: { attendanceFinalizedAt: claimedAt } },
    { new: true },
  );

  if (!cls) {
    const existing = await ClassSession.findById(classSessionId).lean();
    if (!existing) throw notFound('Class');
    return {
      classSessionId: String(classSessionId),
      durationMs: 0,
      enrolledCount: existing.stats?.enrolledCount ?? 0,
      joinedCount: existing.stats?.joinedCount ?? 0,
      presentCount: existing.stats?.presentCount ?? 0,
      avgPresencePct: existing.stats?.avgPresencePct ?? 0,
      alreadyFinalized: true,
    };
  }

  const windowStart = cls.actualStartAt;
  const windowEnd = cls.actualEndAt ?? claimedAt;

  // Close anything still open, so no segment is left running past the class.
  await AttendanceRecord.updateMany(
    { classSession: cls._id, 'segments.leftAt': null },
    { $set: { 'segments.$.leftAt': windowEnd, 'segments.$.closedBy': 'session_end', lastLeftAt: windowEnd } },
  );

  // Every verified student in the batch is expected, so a no-show gets an
  // explicit `absent` row rather than silently missing from analytics.
  const enrolled = await User.find({ batch: cls.batch, role: 'student', status: 'verified' })
    .select('_id')
    .lean();

  if (enrolled.length > 0) {
    await AttendanceRecord.bulkWrite(
      enrolled.map((s) => ({
        updateOne: {
          filter: { classSession: cls._id, student: s._id },
          update: {
            $setOnInsert: { classSession: cls._id, batch: cls.batch, student: s._id, segments: [] },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const records = await AttendanceRecord.find({ classSession: cls._id });

  const durationMs = windowStart ? windowEnd.getTime() - windowStart.getTime() : 0;

  if (!windowStart || durationMs < MIN_CREDITABLE_DURATION_MS) {
    logger.warn(
      { classSessionId: String(cls._id), durationMs },
      'Class was never started or ran under a minute; everyone marked absent.',
    );
  }

  let presentCount = 0;
  let joinedCount = 0;
  let pctSum = 0;

  const ops = records.map((rec) => {
    const computed = windowStart
      ? computePresence(rec.segments, windowStart, windowEnd, cls.attendanceThresholdPct)
      : { totalPresentMs: 0, presencePct: 0, status: 'absent' as AttendanceStatus };

    // An admin override decides the final status, but the computed numbers are
    // kept so a dispute can be re-examined against what actually happened.
    const effectiveStatus = rec.override?.status ?? computed.status;

    if (effectiveStatus === 'present') presentCount += 1;
    if (rec.segments.length > 0) joinedCount += 1;
    pctSum += computed.presencePct;

    return {
      updateOne: {
        filter: { _id: rec._id },
        update: {
          $set: {
            totalPresentMs: computed.totalPresentMs,
            presencePct: computed.presencePct,
            status: effectiveStatus,
            finalizedAt: claimedAt,
          },
        },
      },
    };
  });

  if (ops.length > 0) await AttendanceRecord.bulkWrite(ops, { ordered: false });

  const stats = {
    enrolledCount: records.length,
    joinedCount,
    presentCount,
    avgPresencePct: records.length ? Math.round((pctSum / records.length) * 100) / 100 : 0,
  };

  await ClassSession.updateOne({ _id: cls._id }, { $set: { stats } });

  logger.info({ classSessionId: String(cls._id), ...stats, durationMs }, 'Attendance finalized');

  return { classSessionId: String(cls._id), durationMs, ...stats, alreadyFinalized: false };
}

/**
 * Recomputes a finalized class in place.
 *
 * Needed when an admin corrects `actualStartAt` or `actualEndAt` after the
 * fact — a class the admin forgot to end at the right time would otherwise
 * leave everyone below the threshold against an inflated denominator.
 */
export async function recomputeClassSession(
  classSessionId: Types.ObjectId | string,
): Promise<FinalizeResult> {
  await ClassSession.updateOne({ _id: classSessionId }, { $set: { attendanceFinalizedAt: null } });
  return finalizeClassSession(classSessionId);
}

/* -------------------------------------------------------------------------- */
/* Live view                                                                   */
/* -------------------------------------------------------------------------- */

export interface LivePresenceRow {
  studentId: string;
  name: string;
  email: string;
  inRoom: boolean;
  totalPresentMs: number;
  presencePct: number;
  /** What they would be marked if the class ended right now. */
  projectedStatus: AttendanceStatus;
  lastHeartbeatAt: Date | null;
}

/**
 * The admin's live panel: presence computed as of this instant, written
 * nowhere. The denominator is the elapsed time so far, so a student who has
 * been in the room since the start reads 100% throughout, rather than slowly
 * climbing towards it.
 */
export async function livePresenceSnapshot(
  classSessionId: Types.ObjectId | string,
): Promise<{ elapsedMs: number; rows: LivePresenceRow[] }> {
  const cls = await ClassSession.findById(classSessionId).lean();
  if (!cls) throw notFound('Class');

  const now = new Date();
  const windowStart = cls.actualStartAt ?? now;
  const windowEnd = cls.actualEndAt ?? now;

  const records = await AttendanceRecord.find({ classSession: cls._id })
    .populate<{ student: { _id: Types.ObjectId; name: string; email: string } }>('student', 'name email')
    .lean();

  const rows = records.map((rec) => {
    const computed = computePresence(rec.segments, windowStart, windowEnd, cls.attendanceThresholdPct);
    return {
      studentId: String(rec.student._id),
      name: rec.student.name,
      email: rec.student.email,
      inRoom: rec.segments.some((s) => s.leftAt === null),
      totalPresentMs: computed.totalPresentMs,
      presencePct: computed.presencePct,
      projectedStatus: computed.status,
      lastHeartbeatAt: rec.lastHeartbeatAt,
    };
  });

  rows.sort((a, b) => b.presencePct - a.presencePct);

  return { elapsedMs: windowEnd.getTime() - windowStart.getTime(), rows };
}
