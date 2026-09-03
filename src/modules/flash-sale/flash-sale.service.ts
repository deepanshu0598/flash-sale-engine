import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { v4 as uuidv4 } from 'uuid';
import { FlashSale, SaleStatus } from './entities/flash-sale.entity.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PurchaseDto } from './dto/purchase.dto.js';
import { RedisService } from '../redis/redis.service.js';
import { ProductService } from '../product/product.service.js';
import { Order, OrderStatus } from '../order/entities/order.entity.js';
import { ORDER_QUEUE, PROCESS_ORDER_JOB } from '../queue/queue.constants.js';

@Injectable()
export class FlashSaleService {
  constructor(
    @InjectRepository(FlashSale)
    private readonly saleRepo: Repository<FlashSale>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    private readonly redis: RedisService,
    private readonly productService: ProductService,
    @InjectQueue(ORDER_QUEUE)
    private readonly orderQueue: any,
  ) {}

  async purchase(
    userId: string,
    saleId: string,
    dto: PurchaseDto,
  ): Promise<{ orderId: string; jobId: string }> {
    const quantity = dto.quantity ?? 1;

    // ── 1. Validate sale ────────────────────────────────────────
    const sale = await this.saleRepo.findOne({ where: { id: saleId } });
    if (!sale) throw new NotFoundException('Sale not found');
    if (sale.status !== SaleStatus.ACTIVE)
      throw new BadRequestException('Sale is not active');

    const now = new Date();
    if (now < sale.startTime) throw new BadRequestException('Sale has not started yet');
    if (now > sale.endTime)   throw new BadRequestException('Sale has ended');

    // ── 2. Per-user limit check ─────────────────────────────────
    const alreadyBought = await this.orderRepo.count({
      where: {
        userId,
        flashSaleId: saleId,
        status: Not(OrderStatus.FAILED),
      },
    });
    if (alreadyBought + quantity > sale.maxPerUser) {
      throw new BadRequestException(
        `You can only buy ${sale.maxPerUser} item(s) per sale`,
      );
    }

    // ── 3. Acquire distributed lock ─────────────────────────────
    const lockValue = uuidv4();
    const locked = await this.redis.acquireLock(saleId, 5000, lockValue);
    if (!locked) {
      throw new ConflictException('Sale is busy right now — please retry');
    }

    try {
      // ── 4. Atomic inventory deduction via Lua ──────────────────
      const remaining = await this.redis.deductInventory(saleId, quantity);

      if (remaining === -2)
        throw new InternalServerErrorException('Sale inventory not initialized');
      if (remaining < 0)
        throw new ConflictException('Sold out');

      // ── 5. Create PENDING order in DB ──────────────────────────
      const order = this.orderRepo.create({
        userId,
        flashSaleId: saleId,
        productId: sale.productId,
        quantity,
        totalAmount: Number(sale.salePrice) * quantity,
        status: OrderStatus.PENDING,
      });
      const saved = await this.orderRepo.save(order);

      // ── 6. Enqueue BullMQ job ───────────────────────────────────
      const job = await this.orderQueue.add(
        PROCESS_ORDER_JOB,
        {
          orderId: saved.id,
          userId,
          saleId,
          quantity,
          amount: saved.totalAmount,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      await this.orderRepo.update(saved.id, { jobId: job.id.toString() });

      return { orderId: saved.id, jobId: job.id.toString() };

    } finally {
      // ── 7. Always release lock (even on error) ──────────────────
      await this.redis.releaseLock(saleId, lockValue);
    }
  }

  async create(dto: CreateSaleDto): Promise<FlashSale> {
    await this.productService.findOne(dto.productId);

    const startTime = new Date(dto.startTime);
    const endTime   = new Date(dto.endTime);

    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const sale = this.saleRepo.create({
      productId:  dto.productId,
      salePrice:  dto.salePrice,
      totalStock: dto.totalStock,
      startTime,
      endTime,
      maxPerUser: dto.maxPerUser ?? 1,
      status:     SaleStatus.ACTIVE,
    });

    const saved = await this.saleRepo.save(sale);
    await this.redis.initInventory(saved.id, saved.totalStock);
    return saved;
  }

  async findAll(): Promise<object[]> {
    const sales = await this.saleRepo.find({
      relations: { product: true },
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      sales.map(async (sale) => ({
        ...sale,
        liveStock: await this.redis.getInventory(sale.id),
        liveSold:  await this.redis.getSoldCount(sale.id),
      })),
    );
  }

  async findOne(id: string): Promise<object> {
    const sale = await this.saleRepo.findOne({
      where: { id },
      relations: { product: true },
    });
    if (!sale) throw new NotFoundException('Flash sale not found');

    const liveStock = await this.redis.getInventory(id);
    const liveSold  = await this.redis.getSoldCount(id);

    return { ...sale, liveStock, liveSold };
  }

  async findOneEntity(id: string): Promise<FlashSale> {
    const sale = await this.saleRepo.findOne({ where: { id } });
    if (!sale) throw new NotFoundException('Flash sale not found');
    return sale;
  }
}
