import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { FlashSaleService } from '../../src/modules/flash-sale/flash-sale.service.js';
import { SaleStatus } from '../../src/modules/flash-sale/entities/flash-sale.entity.js';
import { OrderStatus } from '../../src/modules/order/entities/order.entity.js';

// ─── Mock dependencies ────────────────────────────────────────────────────────

const saleRepo = {
  findOne: vi.fn(),
  create:  vi.fn(),
  save:    vi.fn(),
};

const orderRepo = {
  create: vi.fn(),
  save:   vi.fn(),
  update: vi.fn(),
};

const redisService = {
  getInventory:               vi.fn(),
  getInventoryOrNull:         vi.fn(),
  reinitInventoryIfMissing:   vi.fn(),
  getSaleFromCache:           vi.fn(),
  setSaleCache:               vi.fn(),
  atomicPurchase:             vi.fn(),
};

const productService = { findOne: vi.fn() };

const orderQueue = { add: vi.fn() };

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const userId  = 'user-uuid';
const saleId  = 'sale-uuid';
const dto     = { quantity: 1 };

const mockSale = {
  id:         saleId,
  productId:  'product-uuid',
  salePrice:  999,
  totalStock: 100,
  soldCount:  0,
  status:     SaleStatus.ACTIVE,
  startTime:  new Date(Date.now() - 60_000), // 1 min ago
  endTime:    new Date(Date.now() + 60_000), // 1 min from now
  maxPerUser: 2,
  createdAt:  new Date(),
};

// ─── Service under test ───────────────────────────────────────────────────────

let service: FlashSaleService;

beforeEach(() => {
  vi.clearAllMocks();

  service = new FlashSaleService(
    saleRepo as any,
    orderRepo as any,
    redisService as any,
    productService as any,
    orderQueue as any,
  );

  // Default happy-path stubs (overridden per test as needed)
  redisService.getInventory.mockResolvedValue(50);
  redisService.getInventoryOrNull.mockResolvedValue(50);
  redisService.reinitInventoryIfMissing.mockResolvedValue(undefined);
  redisService.getSaleFromCache.mockResolvedValue(mockSale);
  redisService.setSaleCache.mockResolvedValue(undefined);
  redisService.atomicPurchase.mockResolvedValue(49);  // remaining stock after deduction
  orderRepo.create.mockReturnValue({ id: 'order-uuid', status: OrderStatus.PENDING });
  orderRepo.save.mockResolvedValue({ id: 'order-uuid' });
  orderRepo.update.mockResolvedValue(undefined);
  orderQueue.add.mockResolvedValue({ id: 'job-1' });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FlashSaleService.purchase()', () => {

  // ── Step 0: Quick pre-check ─────────────────────────────────────────────────
  describe('Step 0 — quick pre-check', () => {
    it('throws 409 immediately when quickStock is 0 — no Lua, no DB', async () => {
      redisService.getInventoryOrNull.mockResolvedValue(0);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(ConflictException);

      expect(redisService.atomicPurchase).not.toHaveBeenCalled();
      expect(saleRepo.findOne).not.toHaveBeenCalled();
    });

    it('does NOT throw 409 when the key is missing (null) — falls through to the guard', async () => {
      redisService.getInventoryOrNull.mockResolvedValue(null);

      const result = await service.purchase(userId, saleId, dto);

      expect(result).toEqual({ orderId: 'order-uuid', jobId: 'job-1' });
    });
  });

  // ── Sale Init Guard ──────────────────────────────────────────────────────────
  describe('Sale Init Guard — Redis inventory key missing', () => {
    it('reinitializes from DB (totalStock - soldCount) when quickStock is null', async () => {
      redisService.getInventoryOrNull.mockResolvedValue(null);

      await service.purchase(userId, saleId, dto);

      expect(redisService.reinitInventoryIfMissing).toHaveBeenCalledWith(
        saleId,
        mockSale.totalStock - mockSale.soldCount,
      );
    });

    it('does NOT call reinitInventoryIfMissing when quickStock is a real number', async () => {
      redisService.getInventoryOrNull.mockResolvedValue(50);

      await service.purchase(userId, saleId, dto);

      expect(redisService.reinitInventoryIfMissing).not.toHaveBeenCalled();
    });

    it('retries atomicPurchase once when Lua still returns -2 after the guard, and succeeds on retry', async () => {
      redisService.getInventoryOrNull.mockResolvedValue(null);
      redisService.atomicPurchase
        .mockResolvedValueOnce(-2)  // first attempt: still not initialized
        .mockResolvedValueOnce(49); // retry after reinit: succeeds

      const result = await service.purchase(userId, saleId, dto);

      expect(redisService.atomicPurchase).toHaveBeenCalledTimes(2);
      expect(redisService.reinitInventoryIfMissing).toHaveBeenCalledTimes(2); // Step 1.5 + retry path
      expect(result).toEqual({ orderId: 'order-uuid', jobId: 'job-1' });
    });

    it('gives up with InternalServerErrorException when Lua still returns -2 after the retry', async () => {
      redisService.atomicPurchase.mockResolvedValue(-2);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(InternalServerErrorException);

      expect(redisService.atomicPurchase).toHaveBeenCalledTimes(2);
    });
  });

  // ── Step 1: Cache-aside sale lookup ─────────────────────────────────────────
  describe('Step 1 — cache-aside sale lookup', () => {
    it('reads sale from Redis cache — does NOT hit DB', async () => {
      redisService.getSaleFromCache.mockResolvedValue(mockSale);

      await service.purchase(userId, saleId, dto);

      expect(saleRepo.findOne).not.toHaveBeenCalled();
    });

    it('falls back to DB on cache miss and caches the result', async () => {
      redisService.getSaleFromCache.mockResolvedValue(null);
      saleRepo.findOne.mockResolvedValue(mockSale);

      await service.purchase(userId, saleId, dto);

      expect(saleRepo.findOne).toHaveBeenCalledTimes(1);
      expect(redisService.setSaleCache).toHaveBeenCalledWith(saleId, mockSale, 60);
    });

    it('throws NotFoundException when cache miss and DB returns null', async () => {
      redisService.getSaleFromCache.mockResolvedValue(null);
      saleRepo.findOne.mockResolvedValue(null);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when sale status is not ACTIVE', async () => {
      redisService.getSaleFromCache.mockResolvedValue({
        ...mockSale,
        status: SaleStatus.ENDED,
      });

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── Step 2: Atomic Lua purchase ──────────────────────────────────────────────
  describe('Step 2 — atomic Lua purchase (inventory + user limit + deduct)', () => {
    it('throws ConflictException when Lua returns -1 (sold out)', async () => {
      redisService.atomicPurchase.mockResolvedValue(-1);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(ConflictException);
    });

    it('throws InternalServerErrorException when Lua returns -2 (not initialized)', async () => {
      redisService.atomicPurchase.mockResolvedValue(-2);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(InternalServerErrorException);
    });

    it('throws BadRequestException when Lua returns -3 (user limit exceeded)', async () => {
      redisService.atomicPurchase.mockResolvedValue(-3);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(BadRequestException);
    });

    it('passes saleId, userId, quantity, maxPerUser to atomicPurchase', async () => {
      await service.purchase(userId, saleId, dto);

      expect(redisService.atomicPurchase).toHaveBeenCalledWith(
        saleId,
        userId,
        1,
        mockSale.maxPerUser,
        expect.any(Number),
      );
    });

    it('does NOT create a DB order when Lua rejects (sold out)', async () => {
      redisService.atomicPurchase.mockResolvedValue(-1);

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('does NOT create a DB order when Lua rejects (user limit)', async () => {
      redisService.atomicPurchase.mockResolvedValue(-3);

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(orderRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────────
  describe('Happy path', () => {
    it('returns orderId and jobId on successful purchase', async () => {
      const result = await service.purchase(userId, saleId, dto);

      expect(result).toEqual({ orderId: 'order-uuid', jobId: 'job-1' });
    });

    it('creates a PENDING order in DB after successful Lua deduction', async () => {
      await service.purchase(userId, saleId, dto);

      expect(orderRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          flashSaleId: saleId,
          status: OrderStatus.PENDING,
        }),
      );
      expect(orderRepo.save).toHaveBeenCalledTimes(1);
    });

    it('enqueues a BullMQ job after DB order creation', async () => {
      await service.purchase(userId, saleId, dto);

      expect(orderQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ orderId: 'order-uuid', userId, saleId }),
        expect.any(Object),
      );
    });
  });
});
