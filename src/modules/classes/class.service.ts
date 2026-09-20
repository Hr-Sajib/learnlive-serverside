import mongoose, { type Types } from 'mongoose';
import { Batch } from '@/models/batch.model';
import { ClassSession, type IClassSession } from '@/models/classSession.model';
import { User } from '@/models/user.model';
import { AttendanceRecord } from '@/models/attendance.model';
import { closeRoom, mintJoinToken } from '@/lib/livekit';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { badRequest, conflict, forbidden, notFound } from '@/utils/AppError';
import { finalizeClassSession, type FinalizeResult } from '@/modules/attendance/attendance.engine';
import type { AuthedUser } from '@/middleware/auth';

/**
 * Class lifecycle: scheduled -> live -> ended, with `cancelled` as an exit
 * from `scheduled`.
 *
 * Every transition below is written as a guarded `findOneAndUpdate` that names
 * the state it expects to move out of. Two admins double-clicking "Start
 * class" must not produce two `actualStartAt` values, because the second one
 * would silently shorten the attendance window for everybody.
 */

/**
 * LiveKit room names are a flat global namespace shared by every class this
 * project will ever run, so the class id — already unique — is what makes the
 * name collision-proof.
 */
export const roomNameFor = (classSessionId: Types.ObjectId | string): string =>
  `class_${String(classSessionId)}`;

export interface CreateClassInput {
  batchId: string;
  title: string;
  description?: string | null;
  scheduledStartAt: Date;
  scheduledDurationMin: number;
  attendanceThresholdPct?: number;
}

export async function createClass(input: CreateClassInput, adminId: string): Promise<IClassSession> {
  const batch = await Batch.findById(input.batchId).lean();
  if (!batch) throw notFound('Batch');
  if (batch.status !== 'active') {
    throw badRequest('That batch is archived, so no new classes can be scheduled for it.', 'BATCH_ARCHIVED');
  }

  const id = new mongoose.Types.ObjectId();

  return ClassSession.create({
    _id: id,
    batch: batch._id,
    title: input.title,
    description: input.description ?? null,
    host: adminId,
    scheduledStartAt: input.scheduledStartAt,
    scheduledDurationMin: input.scheduledDurationMin,
    status: 'scheduled',
    roomName: roomNameFor(id),
    attendanceThresholdPct: input.attendanceThresholdPct ?? config.attendance.thresholdPct,
  });
}

/**
 * Opens the class.
 *
 * `actualStartAt` is stamped here and it is the start of the attendance
 * window. Time a student spent sitting in the room beforehand is deliberately
 * not credited — the engine clamps every segment to this instant.
 */
export async function startClass(classSessionId: string, adminId: string): Promise<IClassSession> {
  const now = new Date();

  const cls = await ClassSession.findOneAndUpdate(
    { _id: classSessionId, status: 'scheduled' },
    { $set: { status: 'live', actualStartAt: now, host: adminId } },
    { new: true },
  );

  if (!cls) {
    const existing = await ClassSession.findById(classSessionId).lean();
    if (!existing) throw notFound('Class');
    if (existing.status === 'live') throw conflict('That class is already live.', 'ALREADY_LIVE');
    throw conflict(`A ${existing.status} class cannot be started.`, 'INVALID_TRANSITION');
  }

  // Seed a record per enrolled student so the admin's live panel can show
  // who has not turned up yet, not only who has.
  const enrolled = await User.find({ batch: cls.batch, role: 'student', status: 'verified' })
    .select('_id')
    .lean();

  if (enrolled.length > 0) {
    await AttendanceRecord.bulkWrite(
      enrolled.map((s) => ({
        updateOne: {
          filter: { classSession: cls._id, student: s._id },
          update: { $setOnInsert: { classSession: cls._id, batch: cls.batch, student: s._id, segments: [] } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  logger.info({ classSessionId: String(cls._id), enrolled: enrolled.length }, 'Class started');
  return cls;
}

/**
 * Closes the class and freezes attendance.
 *
 * The LiveKit room is deleted first so that nobody can keep accumulating
 * presence time against a class that has already been scored. Finalization
 * then closes every still-open segment at `actualEndAt`.
 */
export async function endClass(classSessionId: string): Promise<FinalizeResult> {
  const now = new Date();

  const cls = await ClassSession.findOneAndUpdate(
    { _id: classSessionId, status: 'live' },
    { $set: { status: 'ended', actualEndAt: now } },
    { new: true },
  );

  if (!cls) {
    const existing = await ClassSession.findById(classSessionId).lean();
    if (!existing) throw notFound('Class');
    if (existing.status === 'ended') {
      // Idempotent: the admin pressing End twice should see the result, not an error.
      return finalizeClassSession(existing._id);
    }
    throw conflict(`A ${existing.status} class cannot be ended.`, 'INVALID_TRANSITION');
  }

  await closeRoom(cls.roomName);
  return finalizeClassSession(cls._id);
}

export async function cancelClass(classSessionId: string): Promise<IClassSession> {
  const cls = await ClassSession.findOneAndUpdate(
    { _id: classSessionId, status: 'scheduled' },
    { $set: { status: 'cancelled' } },
    { new: true },
  );

  if (!cls) {
    const existing = await ClassSession.findById(classSessionId).lean();
    if (!existing) throw notFound('Class');
    throw conflict(
      existing.status === 'live'
        ? 'End the class instead — it is already running.'
        : `A ${existing.status} class cannot be cancelled.`,
      'INVALID_TRANSITION',
    );
  }
  return cls;
}

export interface JoinGrant {
  token: string;
  wsUrl: string;
  roomName: string;
  isHost: boolean;
  classSession: {
    id: string;
    title: string;
    startedAt: Date | null;
    scheduledDurationMin: number;
    attendanceThresholdPct: number;
  };
}

/**
 * Issues a LiveKit join token, and is the single gate on who can enter a room.
 *
 * Authorisation lives here rather than in the client, because a LiveKit token
 * is a bearer credential: once minted it grants room access regardless of what
 * the UI does afterwards. So the checks are:
 *
 *   - the class exists and is currently live;
 *   - the caller is a verified member of that class's batch, or an admin;
 *   - the token's identity is the caller's user id, which is what ties every
 *     later presence webhook back to their attendance record.
 */
export async function issueJoinToken(classSessionId: string, user: AuthedUser): Promise<JoinGrant> {
  const cls = await ClassSession.findById(classSessionId).lean();
  if (!cls) throw notFound('Class');

  const isHost = user.role === 'admin';

  if (!isHost) {
    if (!user.batchId || String(cls.batch) !== user.batchId) {
      throw forbidden('This class belongs to a different batch.');
    }
    if (cls.status !== 'live') {
      throw conflict(
        cls.status === 'scheduled'
          ? 'This class has not started yet. You will be able to join once your coach opens it.'
          : `This class has ${cls.status === 'ended' ? 'ended' : 'been cancelled'}.`,
        'CLASS_NOT_LIVE',
      );
    }
    // Create the record up front so a student who joins is visible on the live
    // panel even before the first presence webhook lands.
    await AttendanceRecord.updateOne(
      { classSession: cls._id, student: user.id },
      { $setOnInsert: { classSession: cls._id, batch: cls.batch, student: user.id, segments: [] } },
      { upsert: true },
    );
  } else if (cls.status !== 'live' && cls.status !== 'scheduled') {
    throw conflict(`A ${cls.status} class cannot be joined.`, 'CLASS_NOT_LIVE');
  }

  const { token, wsUrl } = await mintJoinToken({
    roomName: cls.roomName,
    identity: user.id,
    displayName: user.name,
    isHost,
  });

  return {
    token,
    wsUrl,
    roomName: cls.roomName,
    isHost,
    classSession: {
      id: String(cls._id),
      title: cls.title,
      startedAt: cls.actualStartAt,
      scheduledDurationMin: cls.scheduledDurationMin,
      attendanceThresholdPct: cls.attendanceThresholdPct,
    },
  };
}
