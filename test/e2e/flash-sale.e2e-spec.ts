import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { RedisService } from '../../src/modules/redis/redis.service.js';

// ─── App lifecycle ────────────────────────────────────────────────────────────

let app: INestApplication;
let dataSource: DataSource;
let redis: RedisService;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init();

  dataSource = module.get(DataSource);
  redis      = module.get(RedisService);
}, 30_000);

afterAll(async () => {
  await app.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const http = () => request(app.getHttpServer());

let _emailSeq = 0;
async function registerAndLogin(): Promise<string> {
  const email = `e2e_${Date.now()}_${++_emailSeq}@test.com`;
  await http()
    .post('/auth/register')
    .send({ name: 'E2E User', email, password: 'password123' });

  const res = await http()
    .post('/auth/login')
    .send({ email, password: 'password123' });

  return res.body.access_token as string;
}

async function createProduct(token: string): Promise<string> {
  const res = await http()
    .post('/products')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: `E2E Product ${Date.now()}`,
      originalPrice: 10000,
      description: 'E2E test product',
    });
  return res.body.id as string;
}

async function createSale(
  token: string,
  productId: string,
  stock: number,
): Promise<string> {
  const res = await http()
    .post('/flash-sales')
    .set('Authorization', `Bearer ${token}`)
    .send({
      productId,
      salePrice: 5000,
      totalStock: stock,
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime:   new Date(Date.now() + 60 * 60_000).toISOString(),
      maxPerUser: 1,
    });
  return res.body.id as string;
}

async function waitForOrderStatus(
  orderId: string,
  token: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await http()
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`);
    const status = res.body.status as string;
    if (status !== 'pending' && status !== 'processing') return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Order ${orderId} did not settle within ${timeoutMs}ms`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Flash Sale Engine (e2e)', () => {

  describe('Happy path', () => {
    it('completes full purchase: HTTP → Redis → BullMQ → DB', async () => {
      const token     = await registerAndLogin();
      const productId = await createProduct(token);
      const saleId    = await createSale(token, productId, 10);

      const res = await http()
        .post(`/flash-sales/${saleId}/purchase`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: 1 })
        .expect(201);

      expect(res.body).toHaveProperty('orderId');
      expect(res.body).toHaveProperty('jobId');

      // Redis stock decremented
      const remaining = await redis.getInventory(saleId);
      expect(remaining).toBe(9);

      // Wait for BullMQ processor to confirm the order
      const finalStatus = await waitForOrderStatus(res.body.orderId, token);
      expect(finalStatus).toBe('confirmed');
    }, 15_000);
  });

  describe('Sold out', () => {
    it('returns 409 immediately when stock is 0', async () => {
      const token     = await registerAndLogin();
      const productId = await createProduct(token);
      const saleId    = await createSale(token, productId, 0);

      await http()
        .post(`/flash-sales/${saleId}/purchase`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: 1 })
        .expect(409);
    }, 15_000);
  });

  describe('No overselling — core proof', () => {
    it('never sells more than stock under 20 concurrent requests', async () => {
      const STOCK      = 5;
      const CONCURRENT = 20;

      // Admin token to create sale
      const adminToken = await registerAndLogin();
      const productId  = await createProduct(adminToken);
      const saleId     = await createSale(adminToken, productId, STOCK);

      // 20 different users — so maxPerUser=1 isn't the bottleneck
      const tokens = await Promise.all(
        Array.from({ length: CONCURRENT }, () => registerAndLogin()),
      );

      // Fire all 20 requests at exactly the same time
      const results = await Promise.all(
        tokens.map((t) =>
          http()
            .post(`/flash-sales/${saleId}/purchase`)
            .set('Authorization', `Bearer ${t}`)
            .send({ quantity: 1 }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 201).length;
      const soldOut   = results.filter((r) => r.status === 409).length;
      const errors    = results.filter((r) => r.status >= 500).length;

      console.log(`Results: ${succeeded} succeeded, ${soldOut} 409s, ${errors} 5xx`);

      // ── CRITICAL assertions ──────────────────────────────────────
      // Must never exceed stock — this is the whole point of the engine
      expect(succeeded).toBeLessThanOrEqual(STOCK);
      expect(succeeded + soldOut + errors).toBe(CONCURRENT);

      // Redis must reflect the correct remaining stock (5xx don't deduct)
      const remaining = await redis.getInventory(saleId);
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(STOCK - remaining).toBe(succeeded);

    }, 30_000);
  });

});
