import { Schema, model, type Document, type Types } from 'mongoose';

export type BatchStatus = 'active' | 'archived';

export interface IBatch extends Document {
  _id: Types.ObjectId;
  /** The code a student types at registration, e.g. "B12-FRONTEND". Always uppercase. */
  code: string;
  title: string;
  description: string | null;
  status: BatchStatus;
  startDate: Date | null;
  endDate: Date | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: null, maxlength: 2000 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export const Batch = model<IBatch>('Batch', batchSchema);
