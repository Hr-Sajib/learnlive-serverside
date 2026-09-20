import type { Request, Response } from 'express';
import type { WebhookEvent } from 'livekit-server-sdk';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import { parseWebhook } from '@/lib/livekit';
import { logger } from '@/lib/logger';
import { ClassSession } from '@/models/classSession.model';
import { User } from '@/models/user.model';
import { closeSegment, ensureRecord, finalizeClassSession, openSegment } from '@/modules/attendance/attendance.engine';

/**
 * LiveKit's server-side presence feed — the only trusted input to attendance.
 *
 * Three rules govern this handler:
 *
 *  1. It must be mounted with `express.raw({ type: 'application/webhook+json' })`.
 *     The signature covers the exact bytes LiveKit sent, so a JSON body parser
 *     upstream would reparse them and break verification.
 *
 *  2. It always answers 200, even when processing fails. LiveKit retries on a
 *     non-2xx, and a retry storm caused by one malformed event would delay the
 *     presence events for every other class. Failures are logged, and the
 *     reconciliation sweep repairs whatever was missed.
 *
 *  3. Every write it performs is idempotent, because LiveKit guarantees
 *     at-least-once delivery, not exactly-once.
 */
export async function handleLiveKitWebhook(req: Request, res: Response): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth) {
    res.status(StatusCodes.UNAUTHORIZED).json({ success: false, message: 'Missing signature.' });
    return;
  }

  let event: WebhookEvent;
  try {
    // `req.body` is a Buffer here because of the raw body parser on this route.
    event = await parseWebhook(req.body as Buffer, auth);
  } catch (err) {
    // A bad signature is a real rejection, not a processing hiccup.
    logger.warn({ err }, 'Rejected LiveKit webhook with an invalid signature');
    res.status(StatusCodes.UNAUTHORIZED).json({ success: false, message: 'Invalid signature.' });
    return;
  }

  // Acknowledge before doing the work. LiveKit's delivery timeout is short,
  // and a slow database write must not turn into a redelivery.
  res.status(StatusCodes.OK).json({ received: true });

  try {
    await processEvent(event);
  } catch (err) {
    logger.error({ err, event: event.event }, 'Failed to process LiveKit webhook');
  }
}

async function processEvent(event: WebhookEvent): Promise<void> {
  const roomName = event.room?.name;
  if (!roomName) return;

  switch (event.event) {
    case 'participant_joined':
      await onParticipantJoined(roomName, event);
      break;
    case 'participant_left':
      await onParticipantLeft(roomName, event);
      break;
    case 'room_finished':
      await onRoomFinished(roomName, event);
      break;
    default:
      // room_started, track_published and friends carry nothing we need.
      break;
  }
}

async function onParticipantJoined(roomName: string, event: WebhookEvent): Promise<void> {
  const ctx = await resolveStudent(roomName, event.participant?.identity);
  if (!ctx) return;

  const at = eventTime(event);
  const opened = await openSegment(ctx.classSessionId, ctx.studentId, at, 'webhook');

  logger.debug(
    { roomName, studentId: ctx.studentId, opened },
    opened ? 'Presence segment opened' : 'Join ignored: a segment was already open',
  );
}

async function onParticipantLeft(roomName: string, event: WebhookEvent): Promise<void> {
  const ctx = await resolveStudent(roomName, event.participant?.identity, { createIfMissing: false });
  if (!ctx) return;

  const at = eventTime(event);
  const closed = await closeSegment(ctx.classSessionId, ctx.studentId, at, 'webhook');

  logger.debug(
    { roomName, studentId: ctx.studentId, closed },
    closed ? 'Presence segment closed' : 'Leave ignored: no segment was open',
  );
}

/**
 * LiveKit closes a room once the last participant leaves (or when we delete
 * it). Treating that as the end of the class means a class still gets
 * finalized even if the admin closes their laptop without pressing "End".
 */
async function onRoomFinished(roomName: string, event: WebhookEvent): Promise<void> {
  const cls = await ClassSession.findOne({ roomName });
  if (!cls || cls.status === 'ended' || cls.status === 'cancelled') return;

  const endedAt = eventTime(event);

  await ClassSession.updateOne(
    { _id: cls._id, status: 'live' },
    { $set: { status: 'ended', actualEndAt: endedAt } },
  );

  await finalizeClassSession(cls._id);
  logger.info({ roomName }, 'Class ended by LiveKit room_finished and attendance finalized');
}

interface StudentContext {
  classSessionId: string;
  studentId: string;
}

/**
 * Maps a LiveKit room + participant identity back onto our records.
 *
 * Participant identity is minted as the Mongo user id (see `mintJoinToken`),
 * which is what makes this lookup possible at all. Anyone who is not a
 * verified student of the class's batch — the admin hosting it, above all —
 * is skipped, so the host never appears in their own attendance analytics.
 */
async function resolveStudent(
  roomName: string,
  identity: string | undefined,
  opts: { createIfMissing?: boolean } = {},
): Promise<StudentContext | null> {
  const { createIfMissing = true } = opts;

  if (!identity || !mongoose.isValidObjectId(identity)) return null;

  const cls = await ClassSession.findOne({ roomName }).select('_id batch status').lean();
  if (!cls) {
    logger.warn({ roomName }, 'Presence event for a room with no matching class');
    return null;
  }

  const user = await User.findById(identity).select('role status batch').lean();
  if (!user || user.role !== 'student' || user.status !== 'verified') return null;
  if (String(user.batch) !== String(cls.batch)) return null;

  if (createIfMissing) await ensureRecord(cls._id, cls.batch, user._id);

  return { classSessionId: String(cls._id), studentId: String(user._id) };
}

/**
 * LiveKit stamps events with unix seconds (as a number or a bigint depending
 * on the transport). Server-stamped time is used rather than our own clock so
 * that a webhook delayed in a retry queue still records when the student
 * actually left, not when we got around to hearing about it.
 */
function eventTime(event: WebhookEvent): Date {
  const raw = event.createdAt;
  if (raw === undefined || raw === null) return new Date();

  const seconds = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();

  return new Date(seconds * 1000);
}
