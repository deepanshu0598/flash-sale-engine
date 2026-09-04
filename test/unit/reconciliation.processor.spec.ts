import { ReconciliationProcessor } from '../../src/modules/queue/reconciliation.processor.js';
import { SaleStatus } from '../../src/modules/flash-sale/entities/flash-sale.entity.js';
import { OrderStatus } from '../../src/modules/order/entities/order.entity.js';

const queryBuilder = {
  select: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  andWhere: vi.fn().mockReturnThis(),
  getRawOne: vi.fn(),
};

const orderRepo = {
  createQueryBuilder: vi.fn(() => queryBuilder),
  find: vi.fn(),
  update: vi.fn(),
};

const saleRepo = { find: vi.fn() };

const redisService = {
  getSoldCount: vi.fn(),
  restockInventory: vi.fn(),
};

const orderQueue = { add: vi.fn() };

let processor: ReconciliationProcessor;

const activeSale = {
  id: 'sale-1',
  status: SaleStatus.ACTIVE,
};

beforeEach(() => {
  vi.clearAllMocks();
  queryBuilder.select.mockReturnThis();
  queryBuilder.where.mockReturnThis();
  queryBuilder.andWhere.mockReturnThis();

  processor = new ReconciliationProcessor(
    orderRepo as any,
    saleRepo as any,
    redisService as any,
    orderQueue as any,
  );

  saleRepo.find.mockResolvedValue([activeSale]);
  orderRepo.find.mockResolvedValue([]);
  redisService.getSoldCount.mockResolvedValue(0);
  redisService.restockInventory.mockResolvedValue(undefined);
  queryBuilder.getRawOne.mockResolvedValue({ total: '0' });
  orderQueue.add.mockResolvedValue({ id: 'job-x' });
  orderRepo.update.mockResolvedValue(undefined);
});

describe('ReconciliationProcessor', () => {
  describe('inventory drift', () => {
    it('does nothing when Redis sold count matches DB-reserved quantity', async () => {
      redisService.getSoldCount.mockResolvedValue(10);
      queryBuilder.getRawOne.mockResolvedValue({ total: '10' });

      await processor.handle({} as any);

      expect(redisService.restockInventory).not.toHaveBeenCalled();
    });

    it('restocks the exact drift when Redis sold count exceeds DB-reserved quantity', async () => {
      redisService.getSoldCount.mockResolvedValue(15);
      queryBuilder.getRawOne.mockResolvedValue({ total: '10' }); // 5 units never fulfilled (e.g. FAILED orders)

      await processor.handle({} as any);

      expect(redisService.restockInventory).toHaveBeenCalledWith('sale-1', 5);
    });

    it('only checks ACTIVE sales', async () => {
      await processor.handle({} as any);

      expect(saleRepo.find).toHaveBeenCalledWith({ where: { status: SaleStatus.ACTIVE } });
    });

    it('excludes FAILED orders from the DB-reserved count', async () => {
      await processor.handle({} as any);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'o.status != :failed',
        { failed: OrderStatus.FAILED },
      );
    });
  });

  describe('stranded orders', () => {
    it('does nothing when there are no stranded orders', async () => {
      await processor.handle({} as any);

      expect(orderQueue.add).not.toHaveBeenCalled();
    });

    it('re-enqueues stranded PENDING orders with no jobId and updates the jobId afterward', async () => {
      const stranded = {
        id: 'order-stranded',
        userId: 'user-1',
        flashSaleId: 'sale-1',
        quantity: 2,
        totalAmount: 500,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      };
      orderRepo.find.mockResolvedValue([stranded]);

      await processor.handle({} as any);

      expect(orderQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ orderId: 'order-stranded', userId: 'user-1', saleId: 'sale-1', quantity: 2 }),
        expect.any(Object),
      );
      expect(orderRepo.update).toHaveBeenCalledWith('order-stranded', { jobId: 'job-x' });
    });
  });
});
