import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Append-only trail of admin actions. Attendance is the kind of data students
 * dispute, so every override, verification and class lifecycle change is logged.
 */
export interface IAuditLog extends Document {
  _id: Types.ObjectId;
  actor: Types.ObjectId | null;
  action: string;
  targetType: string | null;
  targetId: Types.ObjectId | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null, index: true },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
