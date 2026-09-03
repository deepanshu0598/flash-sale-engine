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
  count:  vi.fn(),
  create: vi.fn(),
  save:   vi.fn(),
  update: vi.fn(),
};

const redisService = {
  getInventory:     vi.fn(),
  getSaleFromCache: vi.fn(),
  setSaleCache:     vi.fn(),
  acquireLock:      vi.fn(),
  releaseLock:      vi.fn(),
  deductInventory:  vi.fn(),
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
  redisService.getSaleFromCache.mockResolvedValue(mockSale);
  redisService.setSaleCache.mockResolvedValue(undefined);
  redisService.acquireLock.mockResolvedValue(true);
  redisService.releaseLock.mockResolvedValue(undefined);
  redisService.deductInventory.mockResolvedValue(49);
  orderRepo.count.mockResolvedValue(0);
  orderRepo.create.mockReturnValue({ id: 'order-uuid', status: OrderStatus.PENDING });
  orderRepo.save.mockResolvedValue({ id: 'order-uuid' });
  orderRepo.update.mockResolvedValue(undefined);
  orderQueue.add.mockResolvedValue({ id: 'job-1' });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FlashSaleService.purchase()', () => {

  // ── Step 0: Quick pre-check ─────────────────────────────────────────────────
  describe('Step 0 — quick pre-check', () => {
    it('throws 409 immediately when quickStock is 0 — no lock, no DB', async () => {
      redisService.getInventory.mockResolvedValue(0);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(ConflictException);

      expect(redisService.acquireLock).not.toHaveBeenCalled();
      expect(saleRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ── Step 1: Cache-aside sale lookup ─────────────────────────────────────────
  describe('Step 1 — cache-aside sale lookup', () => {
    it('reads sale from Redis cache — does NOT hit DB', async () => {
      redisService.getSaleFromCache.mockResolvedValue(mockSale);
      redisService.acquireLock.mockResolvedValue(false); // fail fast after cache hit

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(saleRepo.findOne).not.toHaveBeenCalled();
    });

    it('falls back to DB on cache miss and caches the result', async () => {
      redisService.getSaleFromCache.mockResolvedValue(null); // cache miss
      saleRepo.findOne.mockResolvedValue(mockSale);
      redisService.acquireLock.mockResolvedValue(false);

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

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

  // ── Step 2: Distributed lock ─────────────────────────────────────────────────
  describe('Step 2 — distributed lock', () => {
    it('throws ConflictException when lock is not acquired', async () => {
      redisService.acquireLock.mockResolvedValue(false);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(ConflictException);
    });
  });

  // ── Step 3: Per-user limit ───────────────────────────────────────────────────
  describe('Step 3 — per-user limit (inside lock)', () => {
    it('throws BadRequestException when user already hit maxPerUser limit', async () => {
      redisService.getSaleFromCache.mockResolvedValue({ ...mockSale, maxPerUser: 1 });
      orderRepo.count.mockResolvedValue(1); // already bought 1, maxPerUser = 1

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── Step 4: Lua inventory deduction ─────────────────────────────────────────
  describe('Step 4 — Lua inventory deduction', () => {
    it('throws ConflictException when Lua returns -1 (sold out)', async () => {
      redisService.deductInventory.mockResolvedValue(-1);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(ConflictException);
    });

    it('throws InternalServerErrorException when Lua returns -2 (not initialized)', async () => {
      redisService.deductInventory.mockResolvedValue(-2);

      await expect(service.purchase(userId, saleId, dto))
        .rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── Step 7: Lock always released (finally) ───────────────────────────────────
  describe('Step 7 — lock always released in finally block', () => {
    it('releases lock even when Lua returns sold out (-1)', async () => {
      redisService.deductInventory.mockResolvedValue(-1);

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('releases lock even when DB save throws', async () => {
      orderRepo.save.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('releases lock even when user limit is exceeded', async () => {
      orderRepo.count.mockResolvedValue(99);

      await expect(service.purchase(userId, saleId, dto)).rejects.toThrow();

      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────────
  describe('Happy path', () => {
    it('returns orderId and jobId on successful purchase', async () => {
      const result = await service.purchase(userId, saleId, dto);

      expect(result).toEqual({ orderId: 'order-uuid', jobId: 'job-1' });
      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('releases lock even on success', async () => {
      await service.purchase(userId, saleId, dto);

      expect(redisService.releaseLock).toHaveBeenCalledTimes(1);
    });
  });
});
