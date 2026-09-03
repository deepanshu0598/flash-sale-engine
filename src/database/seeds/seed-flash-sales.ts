import { faker } from '@faker-js/faker';
import { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { FlashSale, SaleStatus } from '../../modules/flash-sale/entities/flash-sale.entity.js';
import type { Product } from '../../modules/product/entities/product.entity.js';

async function initSaleInRedis(redis: Redis, sale: FlashSale): Promise<void> {
  await redis.set(`inventory:${sale.id}`, sale.totalStock);
  await redis.set(`sold:${sale.id}`, 0);
  await redis.setex(`sale:${sale.id}`, 7200, JSON.stringify(sale));
}

export async function seedFlashSales(
  dataSource: DataSource,
  products: Product[],
  redis: Redis,
): Promise<void> {
  const repo = dataSource.getRepository(FlashSale);
  const endTime2h = new Date(Date.now() + 2 * 60 * 60 * 1000);

  // ── Stress-test sale — 10 stock, 10K users will try to buy ──────
  // Only 10 should succeed. Used to prove no-oversell in k6 load test.
  const [stressProduct, ...rest] = faker.helpers.arrayElements(products, 10);

  const stressSale = repo.create({
    productId: stressProduct.id,
    salePrice: parseFloat((Number(stressProduct.originalPrice) * 0.5).toFixed(2)),
    totalStock: 10,
    status: SaleStatus.ACTIVE,
    startTime: new Date(),
    endTime: endTime2h,
    maxPerUser: 1,
  });
  const savedStress = await repo.save(stressSale);
  await initSaleInRedis(redis, savedStress);
  console.log(`STRESS SALE ${savedStress.id} → stock 10, maxPerUser 1  ← use this for k6`);

  // ── 9 normal faker sales ─────────────────────────────────────────
  const normalSales = rest.map((p) => ({
    productId: p.id,
    salePrice: parseFloat((Number(p.originalPrice) * 0.5).toFixed(2)),
    totalStock: faker.number.int({ min: 50, max: 300 }),
    status: SaleStatus.ACTIVE,
    startTime: new Date(),
    endTime: endTime2h,
    maxPerUser: faker.number.int({ min: 1, max: 3 }),
  }));

  const savedNormal = await repo.save(normalSales);
  for (const sale of savedNormal) {
    await initSaleInRedis(redis, sale);
    console.log(`Sale ${sale.id} → stock ${sale.totalStock}`);
  }

  console.log(`Seeded 10 active flash sales (1 stress + 9 normal)`);
}
