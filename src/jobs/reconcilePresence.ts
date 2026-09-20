import mongoose from 'mongoose';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { listRoomParticipants } from '@/lib/livekit';
import { AttendanceRecord } from '@/models/attendance.model';
import { ClassSession } from '@/models/classSession.model';
import { User } from '@/models/user.model';
import { closeSegment, ensureRecord, finalizeClassSession, openSegment } from '@/modules/attendance/attendance.engine';

/**
 * The safety net under the webhooks.
 *
 * Webhook delivery is best-effort. The failure that actually matters is a
 * dropped `participant_left`: the student's segment stays open, and at
 * finalization it gets closed at the end of the class — handing full
 * attendance to someone who left after ten minutes. The reverse failure (a
 * dropped `participant_joined`) silently robs an honest student of credit.
 *
 * So every minute, for each live class, this sweep asks LiveKit who is
 * genuinely in the room right now and makes our records agree:
 *
 *   in LiveKit, no open segment   -> open one   (missed join)
 *   open segment, not in LiveKit  -> close it   (missed leave)
 *
 * The cost of the repair is bounded by the sweep interval: a missed leave
 * over-credits the student by at most one interval, not by the rest of the class.
 *
 * A class that has been live far past its scheduled length with an empty room
 * is also ended here, so an admin who forgets to press "End class" does not
 * leave attendance permanently unfinalized.
 */

/** How far past its scheduled end an empty live class is auto-ended. */
const STALE_CLASS_GRACE_MS = 30 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPresenceReconciler(): void {
  if (timer) return;
  if (!config.livekit.isConfigured) {
    logger.warn('LiveKit is not configured; presence reconciliation is disabled.');
    return;
  }

  const intervalMs = config.attendance.reconcileIntervalSec * 1000;
  timer = setInterval(() => {
    void runReconcileSweep();
  }, intervalMs);

  // Do not hold the process open for the sake of a background timer.
  timer.unref();

  logger.info({ intervalSec: config.attendance.reconcileIntervalSec }, 'Presence reconciler started');
}

export function stopPresenceReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runReconcileSweep(): Promise<void> {
  // Overlapping sweeps would fight over the same segments; skip rather than queue.
  if (running) return;
  if (mongoose.connection.readyState !== 1) return;

  running = true;
  try {
    const liveClasses = await ClassSession.find({ status: 'live' })
      .select('_id batch roomName actualStartAt scheduledStartAt scheduledDurationMin')
      .lean();

    for (const cls of liveClasses) {
      try {
        await reconcileClass({
          classSessionId: String(cls._id),
          batchId: String(cls.batch),
          roomName: cls.roomName,
          scheduledEndAt: new Date(
            (cls.actualStartAt ?? cls.scheduledStartAt).getTime() + cls.scheduledDurationMin * 60_000,
          ),
        });
      } catch (err) {
        // One bad room must not stop the sweep for every other class.
        logger.error({ err, roomName: cls.roomName }, 'Reconcile failed for class');
      }
    }
  } finally {
    running = false;
  }
}

interface ReconcileArgs {
  classSessionId: string;
  batchId: string;
  roomName: string;
  scheduledEndAt: Date;
}

export async function reconcileClass(args: ReconcileArgs): Promise<void> {
  const { classSessionId, batchId, roomName, scheduledEndAt } = args;
  const now = new Date();

  const participants = await listRoomParticipants(roomName);
  const liveIdentities = new Set(
    participants.map((p) => p.identity).filter((id): id is string => Boolean(id)),
  );

  // An abandoned room well past its scheduled end gets closed out, so the
  // class does not sit "live" forever waiting on an admin who never returns.
  if (liveIdentities.size === 0 && now.getTime() > scheduledEndAt.getTime() + STALE_CLASS_GRACE_MS) {
    await ClassSession.updateOne(
      { _id: classSessionId, status: 'live' },
      { $set: { status: 'ended', actualEndAt: scheduledEndAt } },
    );
    await finalizeClassSession(classSessionId);
    logger.warn({ roomName }, 'Auto-ended a stale live class with an empty room');
    return;
  }

  const records = await AttendanceRecord.find({ classSession: classSessionId })
    .select('student segments')
    .lean();

  const recordByStudent = new Map(records.map((r) => [String(r.student), r]));

  // Repair 1: present in LiveKit but with no open segment (a missed join).
  for (const identity of liveIdentities) {
    if (!mongoose.isValidObjectId(identity)) continue;

    const rec = recordByStudent.get(identity);
    const hasOpen = rec?.segments.some((s) => s.leftAt === null) ?? false;
    if (hasOpen) continue;

    // Confirm they belong here before creating a record for them.
    const user = await User.findById(identity).select('role status batch').lean();
    if (!user || user.role !== 'student' || user.status !== 'verified') continue;
    if (String(user.batch) !== batchId) continue;

    await ensureRecord(classSessionId, batchId, identity);
    const opened = await openSegment(classSessionId, identity, now, 'reconcile');
    if (opened) {
      logger.warn({ roomName, studentId: identity }, 'Reconcile opened a segment for a missed join');
    }
  }

  // Repair 2: an open segment for someone LiveKit says is gone (a missed leave).
  for (const rec of records) {
    const studentId = String(rec.student);
    const hasOpen = rec.segments.some((s) => s.leftAt === null);
    if (!hasOpen || liveIdentities.has(studentId)) continue;

    const closed = await closeSegment(classSessionId, studentId, now, 'reconcile');
    if (closed) {
      logger.warn({ roomName, studentId }, 'Reconcile closed a segment for a missed leave');
    }
  }
}
