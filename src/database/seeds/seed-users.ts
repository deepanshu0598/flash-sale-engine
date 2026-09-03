import { faker } from '@faker-js/faker';
import bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';
import { User } from '../../modules/user/entities/user.entity.js';

const BATCH_SIZE = 500;

export async function seedUsers(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(User);

  // Compute hash once and reuse — 10K × bcrypt(cost=10) = ~17 min otherwise
  const passwordHash = await bcrypt.hash('password123', 10);

  const users = Array.from({ length: 10_000 }, () => ({
    name: faker.person.fullName(),
    email: faker.internet.email().toLowerCase() + '.' + faker.string.nanoid(6),
    passwordHash,
  }));

  // Batch inserts — 10K rows in one save() can cause memory issues
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    await repo.save(users.slice(i, i + BATCH_SIZE));
    process.stdout.write(`\r  Users saved: ${Math.min(i + BATCH_SIZE, users.length)} / ${users.length}`);
  }

  // Known test user — upsert so re-running seed doesn't fail on duplicate email
  await repo.upsert(
    { name: 'Test User', email: 'test@flashsale.com', passwordHash },
    { conflictPaths: ['email'], skipUpdateIfNoValuesChanged: true },
  );

  console.log(`\nSeeded ${users.length + 1} users (test@flashsale.com / password123)`);
}
