import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { RedisService } from '../../modules/redis/redis.service.js';

const WINDOW_SECONDS = 10;
const USER_LIMIT = 5;
const IP_LIMIT = 20;

// Redis-backed fixed-window throttle for POST /flash-sales/:id/purchase.
// Runs after JwtAuthGuard (req.user must already be populated) so the
// per-user limit can key off the authenticated user, not just the IP —
// several users behind one NAT/office IP shouldn't throttle each other.
@Injectable()
export class PurchaseRateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as { id: string } | undefined;
    const ip = req.ip ?? 'unknown';

    if (user) {
      const userCount = await this.redis.incrementRateLimitCounter(
        `ratelimit:user:${user.id}:purchase`,
        WINDOW_SECONDS,
      );
      if (userCount > USER_LIMIT) {
        throw new HttpException(
          'Too many purchase attempts — please slow down',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const ipCount = await this.redis.incrementRateLimitCounter(
      `ratelimit:ip:${ip}:purchase`,
      WINDOW_SECONDS,
    );
    if (ipCount > IP_LIMIT) {
      throw new HttpException(
        'Too many requests from this IP — please slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
