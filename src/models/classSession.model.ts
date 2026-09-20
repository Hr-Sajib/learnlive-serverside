import { Schema, model, type Document, type Types } from 'mongoose';

export type ClassStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';

export interface IClassSession extends Document {
  _id: Types.ObjectId;
  batch: Types.ObjectId;
  title: string;
  description: string | null;
  host: Types.ObjectId;

  scheduledStartAt: Date;
  scheduledDurationMin: number;

  status: ClassStatus;
  /** Set the moment an admin presses "Start class". The attendance clock starts here. */
  actualStartAt: Date | null;
  /** Set when the admin ends the class or the LiveKit room empties out. */
  actualEndAt: Date | null;

  /** Unique LiveKit room name. Format: `class_<classSessionId>`. */
  roomName: string;

  /** Percent of actual duration required for attendance. Snapshotted per class. */
  attendanceThresholdPct: number;
  /** Set once the attendance engine has run its final pass. Records are immutable after this. */
  attendanceFinalizedAt: Date | null;

  /** Denormalised for the batch class list. Written by the attendance engine at finalize. */
  stats: {
    enrolledCount: number;
    joinedCount: number;
    presentCount: number;
    avgPresencePct: number;
  } | null;

  createdAt: Date;
  updatedAt: Date;
}

const classSessionSchema = new Schema<IClassSession>(
  {
    batch: { type: Schema.Types.ObjectId, ref: 'Batch', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: null, maxlength: 4000 },
    host: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    scheduledStartAt: { type: Date, required: true, index: true },
    scheduledDurationMin: { type: Number, required: true, min: 5, max: 600 },

    status: {
      type: String,
      enum: ['scheduled', 'live', 'ended', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    actualStartAt: { type: Date, default: null },
    actualEndAt: { type: Date, default: null },

    roomName: { type: String, required: true, unique: true, index: true },

    attendanceThresholdPct: { type: Number, default: 60, min: 1, max: 100 },
    attendanceFinalizedAt: { type: Date, default: null },

    stats: {
      type: new Schema(
        {
          enrolledCount: { type: Number, default: 0 },
          joinedCount: { type: Number, default: 0 },
          presentCount: { type: Number, default: 0 },
          avgPresencePct: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

// The batch timetable reads exactly this shape.
classSessionSchema.index({ batch: 1, scheduledStartAt: -1 });
// The reconciliation sweep reads exactly this shape.
classSessionSchema.index({ status: 1, actualStartAt: 1 });

export const ClassSession = model<IClassSession>('ClassSession', classSessionSchema);
