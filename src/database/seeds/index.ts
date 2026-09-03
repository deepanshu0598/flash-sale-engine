import 'reflect-metadata';
import { config } from 'dotenv';
config();

import { Redis } from 'ioredis';
import { AppDataSource } from '../data-source.js';
import { seedUsers } from './seed-users.js';
import { seedProducts } from './seed-products.js';
import { seedFlashSales } from './seed-flash-sales.js';

async function runSeeds(): Promise<void> {
  console.log('Connecting to database...');
  await AppDataSource.initialize();

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  });

  try {
    console.log('\n--- Seeding users ---');
    await seedUsers(AppDataSource);

    console.log('\n--- Seeding products ---');
    const products = await seedProducts(AppDataSource);

    console.log('\n--- Seeding flash sales ---');
    await seedFlashSales(AppDataSource, products, redis);

    console.log('\nAll seeds complete.');
  } finally {
    await AppDataSource.destroy();
    await redis.quit();
  }
}

runSeeds().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
