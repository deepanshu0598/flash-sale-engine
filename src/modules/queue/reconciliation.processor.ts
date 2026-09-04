import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import type { Job, Queue } from 'bull';
import { Order, OrderStatus } from '../order/entities/order.entity.js';
import { FlashSale, SaleStatus } from '../flash-sale/entities/flash-sale.entity.js';
import { RedisService } from '../redis/redis.service.js';
import {
  ORDER_QUEUE,
  PROCESS_ORDER_JOB,
  RECONCILE_SALES_JOB,
  RECONCILE_SCHEDULER_JOB_ID,
  RECONCILE_INTERVAL_MS,
  STRANDED_ORDER_THRESHOLD_MS,
} from './queue.constants.js';

// Closes two crash-drift gaps documented in the purchase() flow (see
// flash-sale.service.ts and LEARNING.md Part 4.1):
//
// 1. Redis "sold" count vs DB reserved count drift. The Lua script
//    increments sold:{saleId} the instant a purchase is accepted, before the
//    DB order even exists — and it never gives that unit back if the order
//    later ends up FAILED (payment failure). Over time, failed payments
//    permanently under-count the real available stock. Comparing Redis's
//    sold count against the DB's SUM(quantity) over non-FAILED orders finds
//    exactly this drift and gives the stock back.
// 2. Stranded PENDING orders — a crash between the DB insert (step 3) and
//    the queue enqueue (step 4) in purchase() leaves an order with no jobId
//    that will never be picked up by a worker. Re-enqueuing anything PENDING
//    with jobId IS NULL past a grace window recovers it.
@Injectable()
@Processor(ORDER_QUEUE)
export class ReconciliationProcessor implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(FlashSale)
    private readonly saleRepo: Repository<FlashSale>,
    private readonly redis: RedisService,
    @InjectQueue(ORDER_QUEUE)
    private readonly orderQueue: Queue,
  ) {}

  // Registers the repeatable job once. A fixed jobId makes this idempotent —
  // Bull dedupes repeatable jobs by their key (name + jobId + repeat opts),
  // so restarting the app doesn't stack up duplicate schedules.
  async onModuleInit(): Promise<void> {
    await this.orderQueue.add(
      RECONCILE_SALES_JOB,
      {},
      {
        jobId: RECONCILE_SCHEDULER_JOB_ID,
        repeat: { every: RECONCILE_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  @Process(RECONCILE_SALES_JOB)
  async handle(_job: Job): Promise<void> {
    await this.reconcileInventoryDrift();
    await this.reenqueueStrandedOrders();
  }

  private async reconcileInventoryDrift(): Promise<void> {
    const activeSales = await this.saleRepo.find({ where: { status: SaleStatus.ACTIVE } });

    for (const sale of activeSales) {
      const redisSold = await this.redis.getSoldCount(sale.id);

      const row = await this.orderRepo
        .createQueryBuilder('o')
        .select('COALESCE(SUM(o.quantity), 0)', 'total')
        .where('o.flashSaleId = :saleId', { saleId: sale.id })
        .andWhere('o.status != :failed', { failed: OrderStatus.FAILED })
        .getRawOne<{ total: string }>();

      // An aggregate query with no GROUP BY always returns exactly one row
      // (COALESCE guarantees '0', never NULL) — row is only possibly
      // undefined per TypeORM's generic typing, not in practice.
      const dbReserved = Number(row?.total ?? 0);
      const drift = redisSold - dbReserved;

      if (drift > 0) {
        await this.redis.restockInventory(sale.id, drift);
        this.logger.warn(
          `Sale ${sale.id}: Redis sold count (${redisSold}) exceeded DB-reserved count ` +
          `(${dbReserved}) by ${drift} — restocked (likely from failed-payment orders that ` +
          `never returned their reserved units).`,
        );
      }
    }
  }

  private async reenqueueStrandedOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - STRANDED_ORDER_THRESHOLD_MS);

    const stranded = await this.orderRepo.find({
      where: {
        status: OrderStatus.PENDING,
        jobId: IsNull(),
        createdAt: LessThan(cutoff),
      },
    });

    for (const order of stranded) {
      const job = await this.orderQueue.add(
        PROCESS_ORDER_JOB,
        {
          orderId: order.id,
          userId: order.userId,
          saleId: order.flashSaleId,
          quantity: order.quantity,
          amount: Number(order.totalAmount),
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
      await this.orderRepo.update(order.id, { jobId: job.id.toString() });
      this.logger.warn(`Re-enqueued stranded order ${order.id} (created ${order.createdAt.toISOString()}) — jobId was null`);
    }
  }
}
