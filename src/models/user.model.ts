import { Schema, model, type Document, type Types } from 'mongoose';

export type UserRole = 'student' | 'admin';
export type UserStatus = 'pending' | 'verified' | 'rejected' | 'suspended';

export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  /** Null for admins. A student always belongs to exactly one batch. */
  batch: Types.ObjectId | null;
  /** What the student typed at registration, kept for the admin review screen. */
  requestedBatchCode: string | null;
  verifiedAt: Date | null;
  verifiedBy: Types.ObjectId | null;
  rejectionReason: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, unique: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['student', 'admin'], default: 'student', index: true },
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected', 'suspended'],
      default: 'pending',
      index: true,
    },
    batch: { type: Schema.Types.ObjectId, ref: 'Batch', default: null, index: true },
    requestedBatchCode: { type: String, default: null, uppercase: true, trim: true },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The admin "pending approvals" queue reads exactly this shape.
userSchema.index({ status: 1, createdAt: -1 });
// The batch roster reads exactly this shape.
userSchema.index({ batch: 1, status: 1 });

export const User = model<IUser>('User', userSchema);
