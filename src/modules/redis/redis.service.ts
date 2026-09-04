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
}
