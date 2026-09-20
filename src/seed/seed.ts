import { config } from '@/config';
import { connectDB, disconnectDB } from '@/lib/db';
import { logger } from '@/lib/logger';
import { Batch } from '@/models/batch.model';
import { User } from '@/models/user.model';
import { hashPassword } from '@/modules/auth/auth.service';

/**
 * Bootstraps the first admin and a demo batch.
 *
 * Idempotent: running it twice will not create a second admin, so it is safe
 * to wire into a deploy step.
 */
async function seed(): Promise<void> {
  await connectDB();

  const { adminEmail, adminPhone, adminPassword } = config.seed;
  if (!adminEmail || !adminPhone || !adminPassword) {
    throw new Error('Set SEED_ADMIN_EMAIL, SEED_ADMIN_PHONE and SEED_ADMIN_PASSWORD in .env first.');
  }

  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    admin = await User.create({
      name: 'LearnLive Admin',
      email: adminEmail,
      phone: adminPhone,
      passwordHash: await hashPassword(adminPassword),
      role: 'admin',
      status: 'verified',
      batch: null,
      verifiedAt: new Date(),
    });
    logger.info({ email: adminEmail }, 'Admin created');
  } else {
    logger.info({ email: adminEmail }, 'Admin already exists');
  }

  const code = 'DEMO-B1';
  let batch = await Batch.findOne({ code });
  if (!batch) {
    batch = await Batch.create({
      code,
      title: 'Demo Batch 1',
      description: 'A starter batch so the app has something to show on first run.',
      status: 'active',
      createdBy: admin._id,
    });
    logger.info({ code }, 'Demo batch created');
  }

  logger.info('Seed complete. Sign in at the admin login with the SEED_ADMIN_* credentials.');
}

seed()
  .catch((err) => {
    logger.error({ err }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDB());
