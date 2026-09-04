import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { FlashSale, SaleStatus } from './entities/flash-sale.entity.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PurchaseDto } from './dto/purchase.dto.js';
import { RedisService } from '../redis/redis.service.js';
import { ProductService } from '../product/product.service.js';
import { Order, OrderStatus } from '../order/entities/order.entity.js';
import { ORDER_QUEUE, PROCESS_ORDER_JOB } from '../queue/queue.constants.js';

@Injectable()
export class FlashSaleService {
  private readonly logger = new Logger(FlashSaleService.name);

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

    // ── 0. Quick fail-fast pre-check ────────────────────────────
    // Redis GET ~0.1ms — stops "definitely sold out" requests before
    // they reach the atomic Lua step. Not the authoritative check.
    // A `null` result (key doesn't exist) is NOT the same as sold out — it
    // means Redis lost this sale's inventory key (restart, eviction). That
    // case falls through to the Sale Init Guard below instead of a false 409.
    const quickStock = await this.redis.getInventoryOrNull(saleId);
    if (quickStock !== null && quickStock <= 0) throw new ConflictException('Sold out');

    // ── 1. Validate sale (cache-aside) ──────────────────────────
    // Cache hit  → Redis ~0.1ms, no DB call
    // Cache miss → DB query + cache populated for next request
    let sale = await this.redis.getSaleFromCache<FlashSale>(saleId);
    if (!sale) {
      const found = await this.saleRepo.findOne({ where: { id: saleId } });
      if (!found) throw new NotFoundException('Sale not found');
      await this.redis.setSaleCache(saleId, found, 60);
      sale = found;
    }

    if (sale.status !== SaleStatus.ACTIVE)
      throw new BadRequestException('Sale is not active');

    const now = new Date();
    if (now < new Date(sale.startTime)) throw new BadRequestException('Sale has not started yet');
    if (now > new Date(sale.endTime))   throw new BadRequestException('Sale has ended');

    // ── 1.5 Sale Init Guard ─────────────────────────────────────
    // quickStock === null means inventory:{saleId} doesn't exist even though
    // the sale is ACTIVE in the DB — Redis lost it (restart without AOF
    // persistence, maxmemory-lru eviction, or a manual DEL). Rebuild a
    // best-effort count from the DB instead of failing every purchase with a
    // hard 500 for the rest of the sale. This is a best-effort reconstruction
    // (DB soldCount can lag Redis by a few in-flight orders), not an exact
    // reconciliation — the periodic Redis↔DB reconciliation job (roadmap
    // Phase 2) is what closes that drift precisely.
    if (quickStock === null) {
      await this.ensureInventoryInitialized(sale);
    }

    // ── 2. Atomic purchase — inventory + user limit + deduct ────
    // Single Lua script replaces: distributed lock + DB COUNT + old Lua deduct.
    // Lua executes atomically in Redis — no serialization, no lock needed.
    const ttlSeconds = Math.max(
      Math.ceil((new Date(sale.endTime).getTime() - Date.now()) / 1000),
      60,
    );
    let remaining = await this.redis.atomicPurchase(
      saleId,
      userId,
      quantity,
      sale.maxPerUser,
      ttlSeconds,
    );

    // -2 here means the guard above raced with another eviction, or ran but
    // NX lost to a concurrent reinit that hadn't landed yet. One retry is
    // enough — this path should be rare in practice.
    if (remaining === -2) {
      await this.ensureInventoryInitialized(sale);
      remaining = await this.redis.atomicPurchase(saleId, userId, quantity, sale.maxPerUser, ttlSeconds);
    }

    if (remaining === -2)
      throw new InternalServerErrorException('Sale inventory not initialized');
    if (remaining === -3)
      throw new BadRequestException(`You can only buy ${sale.maxPerUser} item(s) per sale`);
    if (remaining < 0)
      throw new ConflictException('Sold out');

    // ── 3. Create PENDING order in DB ──────────────────────────
    const order = this.orderRepo.create({
      userId,
      flashSaleId: saleId,
      productId: sale.productId,
      quantity,
      totalAmount: Number(sale.salePrice) * quantity,
      status: OrderStatus.PENDING,
    });
    const saved = await this.orderRepo.save(order);

    // ── 4. Enqueue BullMQ job ───────────────────────────────────
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
  }

  // Rebuilds inventory:{saleId} / sold:{saleId} from the DB when Redis has
  // lost them mid-sale. Uses NX writes (via RedisService.reinitInventoryIfMissing)
  // so concurrent purchase() calls racing to self-heal the same sale don't
  // clobber each other.
  //
  // This also doubles as the "Redis key lost" alert: inventory:{saleId} is set
  // with no TTL (see redis.service.ts initInventory) — it doesn't expire on a
  // timer, so a plain "TTL < 60s" check would never fire. The real risk here is
  // eviction under `maxmemory-policy allkeys-lru` (docker/redis.conf) or a
  // restart without persistence. This log line is the actual observable signal
  // for that: it fires exactly when a purchase discovers the key is gone.
  private async ensureInventoryInitialized(sale: FlashSale): Promise<void> {
    const rebuiltStock = Math.max(sale.totalStock - sale.soldCount, 0);
    this.logger.warn(
      `inventory:${sale.id} was missing from Redis — reinitializing from DB ` +
      `(totalStock=${sale.totalStock}, soldCount=${sale.soldCount}, rebuilt=${rebuiltStock})`,
    );
    await this.redis.reinitInventoryIfMissing(sale.id, rebuiltStock);
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
    await this.redis.setSaleCache(saved.id, saved, 3600);
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
