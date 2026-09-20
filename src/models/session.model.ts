import { Schema, model, type Document, type Types } from 'mongoose';

/** A live refresh-token grant. Deleting the row logs that device out. */
export interface ISession extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Mongo drops expired grants on its own; no cleanup job needed.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>('Session', sessionSchema);
