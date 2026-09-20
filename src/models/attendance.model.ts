import { Schema, model, type Document, type Types } from 'mongoose';

/** Which mechanism opened or closed a segment. Used for auditing disputed attendance. */
export type PresenceSource = 'webhook' | 'reconcile' | 'session_end';

export type AttendanceStatus = 'present' | 'partial' | 'absent';

export interface IPresenceSegment {
  joinedAt: Date;
  /** Null while the student is still in the room. */
  leftAt: Date | null;
  openedBy: PresenceSource;
  closedBy: PresenceSource | null;
}

export interface IAttendanceRecord extends Document {
  _id: Types.ObjectId;
  classSession: Types.ObjectId;
  /** Denormalised so batch-wide analytics never has to join through ClassSession. */
  batch: Types.ObjectId;
  student: Types.ObjectId;

  segments: IPresenceSegment[];

  /** Sum of merged, clamped segment durations. Written at finalize. */
  totalPresentMs: number;
  /** totalPresentMs / actual class duration * 100, rounded to 2dp. Written at finalize. */
  presencePct: number;
  status: AttendanceStatus;

  firstJoinedAt: Date | null;
  lastLeftAt: Date | null;

  /**
   * Last client heartbeat. Drives the admin's live "who is in the room" panel
   * ONLY. It is never an input to attendance, because a student could forge it.
   */
  lastHeartbeatAt: Date | null;

  /** An admin may override a computed result; the computed values are kept alongside. */
  override: {
    status: AttendanceStatus;
    reason: string;
    by: Types.ObjectId;
    at: Date;
  } | null;

  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const segmentSchema = new Schema<IPresenceSegment>(
  {
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
    openedBy: { type: String, enum: ['webhook', 'reconcile', 'session_end'], required: true },
    closedBy: { type: String, enum: ['webhook', 'reconcile', 'session_end'], default: null },
  },
  { _id: false },
);

const attendanceSchema = new Schema<IAttendanceRecord>(
  {
    classSession: { type: Schema.Types.ObjectId, ref: 'ClassSession', required: true, index: true },
    batch: { type: Schema.Types.ObjectId, ref: 'Batch', required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    segments: { type: [segmentSchema], default: [] },

    totalPresentMs: { type: Number, default: 0 },
    presencePct: { type: Number, default: 0 },
    status: { type: String, enum: ['present', 'partial', 'absent'], default: 'absent', index: true },

    firstJoinedAt: { type: Date, default: null },
    lastLeftAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date, default: null },

    override: {
      type: new Schema(
        {
          status: { type: String, enum: ['present', 'partial', 'absent'], required: true },
          reason: { type: String, required: true, maxlength: 500 },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One record per student per class. This is what makes the join webhook safely
// idempotent: it upserts on this key rather than inserting a second row.
attendanceSchema.index({ classSession: 1, student: 1 }, { unique: true });
// A student's own attendance history.
attendanceSchema.index({ student: 1, createdAt: -1 });
// Batch-wide analytics.
attendanceSchema.index({ batch: 1, status: 1 });

export const AttendanceRecord = model<IAttendanceRecord>('AttendanceRecord', attendanceSchema);
