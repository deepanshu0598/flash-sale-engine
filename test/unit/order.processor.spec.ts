import { OrderProcessor } from '../../src/modules/queue/order.processor.js';
import { OrderStatus } from '../../src/modules/order/entities/order.entity.js';

const orderRepo = { update: vi.fn() };
const saleRepo = { increment: vi.fn(), findOne: vi.fn() };
const dlqQueue = { add: vi.fn() };

let processor: OrderProcessor;

function mockJob(overrides: Partial<{ attemptsMade: number; attempts: number }> = {}) {
  return {
    id: 'job-1',
    data: { orderId: 'order-1', userId: 'user-1', saleId: 'sale-1', quantity: 1, amount: 999 },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 3 },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  processor = new OrderProcessor(orderRepo as any, saleRepo as any, dlqQueue as any);
  orderRepo.update.mockResolvedValue(undefined);
  saleRepo.increment.mockResolvedValue(undefined);
  saleRepo.findOne.mockResolvedValue({ id: 'sale-1', webhookUrl: null, webhookSecret: null });
  dlqQueue.add.mockResolvedValue({ id: 'dlq-job-1' });
});

describe('OrderProcessor.handle()', () => {
  it('confirms the order on successful payment (mocked to never fail)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // > 0.05, payment "succeeds"

    await processor.handle(mockJob());

    expect(orderRepo.update).toHaveBeenCalledWith('order-1', { status: OrderStatus.CONFIRMED });
    expect(dlqQueue.add).not.toHaveBeenCalled();
  });

  it('does NOT route to the DLQ when a failure happens before the final attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // < 0.05, payment "fails"

    await expect(processor.handle(mockJob({ attemptsMade: 1, attempts: 3 }))).rejects.toThrow();

    expect(dlqQueue.add).not.toHaveBeenCalled();
  });

  it('routes to the DLQ when the failure happens on the final configured attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // payment "fails"

    await expect(processor.handle(mockJob({ attemptsMade: 3, attempts: 3 }))).rejects.toThrow();

    expect(dlqQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orderId: 'order-1', originalJobId: 'job-1' }),
      expect.any(Object),
    );
  });

  it('marks the order FAILED with a reason regardless of retry state', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    await expect(processor.handle(mockJob())).rejects.toThrow();

    expect(orderRepo.update).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ status: OrderStatus.FAILED }),
    );
  });

  describe('order-confirmed webhook', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('does not call fetch when the sale has no webhookUrl configured', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9); // payment succeeds
      global.fetch = vi.fn();

      await processor.handle(mockJob());

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('POSTs an HMAC-signed payload when the sale has a webhookUrl', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      saleRepo.findOne.mockResolvedValue({
        id: 'sale-1',
        webhookUrl: 'https://example.com/hook',
        webhookSecret: 'shh',
      });
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await processor.handle(mockJob());

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(JSON.parse(init.body)).toEqual(
        expect.objectContaining({ orderId: 'order-1', saleId: 'sale-1', status: 'confirmed' }),
      );
    });

    it('does not throw (and does not affect order confirmation) when webhook delivery fails', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      saleRepo.findOne.mockResolvedValue({
        id: 'sale-1',
        webhookUrl: 'https://example.com/hook',
        webhookSecret: 'shh',
      });
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(processor.handle(mockJob())).resolves.toBeUndefined();

      expect(orderRepo.update).toHaveBeenCalledWith('order-1', { status: OrderStatus.CONFIRMED });
    });
  });
});
