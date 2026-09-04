import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import type { Queue } from 'bull';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service.js';
import { ORDER_QUEUE } from '../queue/queue.constants.js';
import {
  ORDER_QUEUE_DEPTH,
  REDIS_POOL_CONNECTED,
  DB_POOL_TOTAL,
  DB_POOL_IDLE,
  DB_POOL_WAITING,
  POOL_GAUGE_UPDATE_INTERVAL_MS,
} from './metrics.constants.js';

// Gauges (point-in-time values, unlike counters/histograms) don't update
// themselves — something has to poll the source and set them. A 15s tick is
// frequent enough for a dashboard, cheap enough not to matter next to actual
// request traffic.
@Injectable()
export class PoolMetricsUpdaterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PoolMetricsUpdaterService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(ORDER_QUEUE)
    private readonly orderQueue: Queue,
    private readonly redis: RedisService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectMetric(ORDER_QUEUE_DEPTH)
    private readonly queueDepthGauge: Gauge<string>,
    @InjectMetric(REDIS_POOL_CONNECTED)
    private readonly redisPoolGauge: Gauge<string>,
    @InjectMetric(DB_POOL_TOTAL)
    private readonly dbPoolTotalGauge: Gauge<string>,
    @InjectMetric(DB_POOL_IDLE)
    private readonly dbPoolIdleGauge: Gauge<string>,
    @InjectMetric(DB_POOL_WAITING)
    private readonly dbPoolWaitingGauge: Gauge<string>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, POOL_GAUGE_UPDATE_INTERVAL_MS);
    this.timer.unref(); // don't hold the process open just for this
    void this.tick(); // populate immediately instead of waiting for the first tick
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const [waiting, active] = await Promise.all([
        this.orderQueue.getWaitingCount(),
        this.orderQueue.getActiveCount(),
      ]);
      this.queueDepthGauge.set({ state: 'waiting' }, waiting);
      this.queueDepthGauge.set({ state: 'active' }, active);

      this.redisPoolGauge.set(this.redis.getConnectedCount());

      // node-postgres's Pool (not a documented TypeORM API — the only way to
      // see pool saturation without hand-rolling our own counter around every
      // query) exposes these as plain synchronous getters.
      const pgPool = (this.dataSource.driver as unknown as { master?: {
        totalCount?: number; idleCount?: number; waitingCount?: number;
      } }).master;
      if (pgPool) {
        this.dbPoolTotalGauge.set(pgPool.totalCount ?? 0);
        this.dbPoolIdleGauge.set(pgPool.idleCount ?? 0);
        this.dbPoolWaitingGauge.set(pgPool.waitingCount ?? 0);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Pool metrics tick failed: ${message}`);
    }
  }
}
