import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Job } from 'bull';
import { Order, OrderStatus } from '../order/entities/order.entity.js';
import { FlashSale } from '../flash-sale/entities/flash-sale.entity.js';
import { ORDER_QUEUE, PROCESS_ORDER_JOB } from './queue.constants.js';

interface OrderJobData {
  orderId: string;
  userId: string;
  saleId: string;
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
  ) {}

  @Process(PROCESS_ORDER_JOB)
  async handle(job: Job<OrderJobData>): Promise<void> {
    const { orderId, saleId, quantity, amount } = job.data;
    this.logger.log(`Processing job ${job.id}, order ${orderId}`);

    try {
      await this.orderRepo.update(orderId, { status: OrderStatus.PROCESSING });

      await this.simulatePayment(amount);

      // Sync sold count to DB (Redis is source of truth during the sale)
      await this.saleRepo.increment({ id: saleId }, 'soldCount', quantity);

      await this.orderRepo.update(orderId, { status: OrderStatus.CONFIRMED });
      this.logger.log(`Order ${orderId} CONFIRMED`);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Order ${orderId} FAILED: ${message}`);

      await this.orderRepo.update(orderId, {
        status: OrderStatus.FAILED,
        failureReason: message,
      });

      // Re-throw so BullMQ retries per the job's `attempts: 3` config
      throw error;
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
