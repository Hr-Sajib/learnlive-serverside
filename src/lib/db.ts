import mongoose from 'mongoose';
import { config } from '@/config';
import { logger } from '@/lib/logger';

export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('MongoDB connected');
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close();
  logger.info('MongoDB disconnected');
}
