import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job, Queue } from 'bull';
import { createHmac } from 'node:crypto';
import { Order, OrderStatus } from '../order/entities/order.entity.js';
import { FlashSale } from '../flash-sale/entities/flash-sale.entity.js';
import { ORDER_QUEUE, PROCESS_ORDER_JOB, ORDER_DLQ, DEAD_ORDER_JOB } from './queue.constants.js';

interface OrderJobData {
  orderId: string;
  userId: string;
  saleId: string;
  quantity: number;
  amount: number;
}

interface OrderConfirmedWebhookPayload {
  orderId: string;
  saleId: string;
  userId: string;
  status: 'confirmed';
  quantity: number;
  amount: number;
}

@Processor(ORDER_QUEUE)
export class OrderProcessor {
  private readonly logger = new Logger(OrderProcessor.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(FlashSale)
    private readonly saleRepo: Repository<FlashSale>,
    @InjectQueue(ORDER_DLQ)
    private readonly dlqQueue: Queue,
  ) {}

  @Process(PROCESS_ORDER_JOB)
  async handle(job: Job<OrderJobData>): Promise<void> {
    const { orderId, userId, saleId, quantity, amount } = job.data;
    this.logger.log(`Processing job ${job.id}, order ${orderId}`);

    try {
      await this.orderRepo.update(orderId, { status: OrderStatus.PROCESSING });

      await this.simulatePayment(amount);

      // Sync sold count to DB (Redis is source of truth during the sale)
      await this.saleRepo.increment({ id: saleId }, 'soldCount', quantity);

      await this.orderRepo.update(orderId, { status: OrderStatus.CONFIRMED });
      this.logger.log(`Order ${orderId} CONFIRMED`);

      await this.sendConfirmedWebhook(saleId, { orderId, saleId, userId, status: 'confirmed', quantity, amount });

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Order ${orderId} FAILED: ${message}`);

      await this.orderRepo.update(orderId, {
        status: OrderStatus.FAILED,
        failureReason: message,
      });

      // attemptsMade is incremented before this call runs, so on the last
      // configured attempt it equals opts.attempts — that's "no more retries
      // coming" without needing to guess bull's internal retry state.
      const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await this.dlqQueue.add(
          DEAD_ORDER_JOB,
          { ...job.data, failureReason: message, originalJobId: job.id },
          { removeOnComplete: false, removeOnFail: false },
        );
        this.logger.error(`Order ${orderId} exhausted all ${job.opts.attempts} attempts — moved to DLQ`);
      }

      // Re-throw so Bull retries per the job's `attempts: 3` config (or, on
      // the final attempt, marks it failed — the DLQ entry above is what
      // actually gets read for manual review at that point).
      throw error;
    }
  }

  // Fire-and-forget on purpose: a webhook delivery failure is the caller's
  // problem to notice and retry (or poll GET /orders/:id instead), not a
  // reason to fail an already-CONFIRMED order or trigger the payment retry
  // path above. Native fetch — no new HTTP client dependency needed on
  // Node 20+.
  private async sendConfirmedWebhook(saleId: string, payload: OrderConfirmedWebhookPayload): Promise<void> {
    const sale = await this.saleRepo.findOne({ where: { id: saleId } });
    if (!sale?.webhookUrl || !sale.webhookSecret) return;

    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', sale.webhookSecret).update(body).digest('hex');

    try {
      const res = await fetch(sale.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        body,
      });
      if (!res.ok) {
        this.logger.warn(`Webhook POST to ${sale.webhookUrl} for order ${payload.orderId} returned ${res.status}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Webhook delivery failed for order ${payload.orderId}: ${message}`);
    }
  }

  private async simulatePayment(amount: number): Promise<void> {
    this.logger.debug(`Simulating payment of ₹${amount}`);
    await new Promise<void>((r) => setTimeout(r, 150));
    if (Math.random() < 0.05) {
      throw new Error('Payment gateway timeout');
    }
  }
}
