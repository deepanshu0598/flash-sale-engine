import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const POOL_SIZE = 5;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private _pool: Redis[] = [];
  private _poolIndex = 0;
  private readonly logger = new Logger(RedisService.name);

  // Round-robin across pool — all existing this.client usages work unchanged
  private get client(): Redis {
    return this._pool[this._poolIndex++ % this._pool.length];
  }

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const options = {
      host: this.config.get<string>('redis.host'),
      port: this.config.get<number>('redis.port'),
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      connectTimeout: 10_000,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    };

    for (let i = 0; i < POOL_SIZE; i++) {
      const conn = new Redis(options);
      conn.on('connect', () => this.logger.log(`Redis [${i}] connected`));
      conn.on('error', (err: Error) => this.logger.error(`Redis [${i}] error`, err));
      this.loadLuaScriptsOn(conn);
      this._pool.push(conn);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this._pool.map((c) => c.quit()));
  }

  private loadLuaScriptsOn(conn: Redis): void {
    const scriptsDir = join(__dirname, 'scripts');

    conn.defineCommand('deductInventory', {
      numberOfKeys: 2,
      lua: readFileSync(join(scriptsDir, 'deduct-inventory.lua'), 'utf8'),
    });

    conn.defineCommand('releaseLock', {
      numberOfKeys: 1,
      lua: readFileSync(join(scriptsDir, 'release-lock.lua'), 'utf8'),
    });

    conn.defineCommand('atomicPurchase', {
      numberOfKeys: 3,
      lua: readFileSync(join(scriptsDir, 'purchase-atomic.lua'), 'utf8'),
    });

    this.logger.log(`Lua scripts loaded on connection`);
  }

  // ─── Distributed Lock ─────────────────────────────────────────────────────
  async acquireLock(resource: string, ttlMs: number, value: string): Promise<boolean> {
    const result = await this.client.set(
      `lock:${resource}`,
      value,
      'PX',
      ttlMs,
      'NX',
    );
    return result === 'OK';
  }

  async releaseLock(resource: string, value: string): Promise<void> {
    await (this.client as any).releaseLock(`lock:${resource}`, value);
  }

  // ─── Inventory ────────────────────────────────────────────────────────────
  async initInventory(saleId: string, stock: number): Promise<void> {
    await this.client.set(`inventory:${saleId}`, stock);
    await this.client.set(`sold:${saleId}`, 0);
  }

  async deductInventory(saleId: string, qty: number): Promise<number> {
    return (this.client as any).deductInventory(
      `inventory:${saleId}`,
      `sold:${saleId}`,
      qty,
    );
  }

  async atomicPurchase(
    saleId: string,
    userId: string,
    qty: number,
    maxPerUser: number,
    ttlSeconds: number,
  ): Promise<number> {
    return (this.client as any).atomicPurchase(
      `inventory:${saleId}`,
      `sold:${saleId}`,
      `user_purchases:${userId}:${saleId}`,
      qty,
      maxPerUser,
      ttlSeconds,
    );
  }

  async getInventory(saleId: string): Promise<number> {
    const val = await this.client.get(`inventory:${saleId}`);
    return val !== null ? parseInt(val, 10) : 0;
  }

  // Distinguishes "genuinely 0 stock" from "key missing entirely" — getInventory()
  // collapses both to 0, which is fine for display but wrong for the purchase
  // flow's Sale Init Guard (a missing key means Redis lost the sale's inventory,
  // not that it sold out).
  async getInventoryOrNull(saleId: string): Promise<number | null> {
    const val = await this.client.get(`inventory:${saleId}`);
    return val !== null ? parseInt(val, 10) : null;
  }

  // Gives units back to inventory when the reconciliation job finds Redis's
  // sold count ahead of what the DB actually has reserved (e.g. failed-payment
  // orders that never returned their unit). Not wrapped in a Lua script — this
  // runs from a single periodic job, not from concurrent purchase() calls, so
  // there's no contention to make atomic here; a live purchase decrementing
  // inventory at the same moment just interleaves normally with these two
  // commands, which is fine for a corrective background pass.
  async restockInventory(saleId: string, qty: number): Promise<void> {
    await this.client.incrby(`inventory:${saleId}`, qty);
    await this.client.decrby(`sold:${saleId}`, qty);
  }

  // NX-based reinit for the Sale Init Guard: only sets keys that are actually
  // missing, so concurrent requests racing to self-heal the same sale don't
  // stomp each other's writes (unlike initInventory(), which is an unconditional
  // overwrite meant for first-time sale creation).
  async reinitInventoryIfMissing(saleId: string, stock: number): Promise<void> {
    await this.client.set(`inventory:${saleId}`, stock, 'NX');
    await this.client.set(`sold:${saleId}`, 0, 'NX');
  }

  async getSoldCount(saleId: string): Promise<number> {
    const val = await this.client.get(`sold:${saleId}`);
    return val !== null ? parseInt(val, 10) : 0;
  }

  // ─── Sale Cache (cache-aside) ─────────────────────────────────────────────
  async getSaleFromCache<T>(saleId: string): Promise<T | null> {
    const val = await this.client.get(`sale:${saleId}`);
    return val ? (JSON.parse(val) as T) : null;
  }

  async setSaleCache<T>(saleId: string, data: T, ttlSeconds = 60): Promise<void> {
    await this.client.setex(`sale:${saleId}`, ttlSeconds, JSON.stringify(data));
  }

  async invalidateSaleCache(saleId: string): Promise<void> {
    await this.client.del(`sale:${saleId}`);
  }

  getClient(): Redis {
    return this._pool[0];
  }

  // ─── Idempotency (purchase dedup on client retry) ──────────────────────────
  // Two-phase: claim the key first (NX — only one concurrent request can win
  // it), do the work, then overwrite the claim with the real result. A
  // concurrent duplicate that loses the claim either gets the cached result
  // (if the first request already finished) or a 409 telling it to retry
  // shortly (if the first request is still mid-flight) — it never re-runs
  // the purchase.
  async claimIdempotencyKey(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, 'PENDING', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async getIdempotentResult<T>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    if (!val || val === 'PENDING') return null;
    return JSON.parse(val) as T;
  }

  async storeIdempotentResult<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  // Releases a claimed-but-failed key so the same idempotency key can be
  // retried — only successful purchases should be memoized forever; a
  // sold-out or validation failure shouldn't permanently lock the key.
  async releaseIdempotencyKey(key: string): Promise<void> {
    await this.client.del(key);
  }

  // ─── Rate Limiting (fixed window) ──────────────────────────────────────────
  // INCR is atomic — concurrent first requests can't both "win" the count===1
  // check, so only one of them sets the window's expiry. Fixed-window (not a
  // true sliding window) is intentional: good enough for abuse throttling,
  // far simpler than a sorted-set sliding window, and consistent with this
  // service's existing style of small, explicit Redis primitives.
  async incrementRateLimitCounter(key: string, windowSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }
}
