import { ExecutionContext, HttpException } from '@nestjs/common';
import { PurchaseRateLimitGuard } from '../../src/common/guards/purchase-rate-limit.guard.js';

const redisService = {
  incrementRateLimitCounter: vi.fn(),
};

function mockContext(user: { id: string } | undefined, ip = '127.0.0.1'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, ip }),
    }),
  } as unknown as ExecutionContext;
}

let guard: PurchaseRateLimitGuard;

beforeEach(() => {
  vi.clearAllMocks();
  guard = new PurchaseRateLimitGuard(redisService as any);
});

describe('PurchaseRateLimitGuard', () => {
  it('allows the request when both counters are under their limits', async () => {
    redisService.incrementRateLimitCounter.mockResolvedValue(1);

    await expect(guard.canActivate(mockContext({ id: 'user-1' }))).resolves.toBe(true);
  });

  it('checks the per-user counter with a user-scoped key', async () => {
    redisService.incrementRateLimitCounter.mockResolvedValue(1);

    await guard.canActivate(mockContext({ id: 'user-1' }));

    expect(redisService.incrementRateLimitCounter).toHaveBeenCalledWith(
      'ratelimit:user:user-1:purchase',
      10,
    );
  });

  it('throws 429 when the per-user count exceeds 5 in the window', async () => {
    redisService.incrementRateLimitCounter.mockResolvedValueOnce(6); // user counter

    await expect(guard.canActivate(mockContext({ id: 'user-1' })))
      .rejects.toThrow(HttpException);
    // IP counter must not even be checked — user limit already rejected
    expect(redisService.incrementRateLimitCounter).toHaveBeenCalledTimes(1);
  });

  it('throws 429 when the per-IP count exceeds 20 in the window', async () => {
    redisService.incrementRateLimitCounter
      .mockResolvedValueOnce(1)   // user counter — under limit
      .mockResolvedValueOnce(21); // IP counter — over limit

    await expect(guard.canActivate(mockContext({ id: 'user-1' })))
      .rejects.toThrow(HttpException);
  });

  it('skips the user counter entirely when there is no authenticated user', async () => {
    redisService.incrementRateLimitCounter.mockResolvedValue(1);

    await guard.canActivate(mockContext(undefined));

    expect(redisService.incrementRateLimitCounter).toHaveBeenCalledTimes(1);
    expect(redisService.incrementRateLimitCounter).toHaveBeenCalledWith(
      expect.stringContaining('ratelimit:ip:'),
      10,
    );
  });
});
