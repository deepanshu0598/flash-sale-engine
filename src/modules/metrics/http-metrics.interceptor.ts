import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Histogram } from 'prom-client';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { HTTP_REQUEST_DURATION } from './metrics.constants.js';

// Global interceptor (registered as APP_INTERCEPTOR in MetricsModule) — every
// HTTP request gets timed. Labels by req.route.path (e.g. "/flash-sales/:id"),
// never the raw URL — a raw path label would create one Prometheus time
// series PER unique sale/order ID, which grows unbounded forever
// ("cardinality explosion") and eventually takes Prometheus down.
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric(HTTP_REQUEST_DURATION)
    private readonly histogram: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { route?: { path: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = req.route?.path ?? req.path;
    const stopTimer = this.histogram.startTimer({ method: req.method, route });

    return next.handle().pipe(
      tap({
        next: () => stopTimer({ status_code: String(res.statusCode) }),
        error: () => stopTimer({ status_code: String(res.statusCode || 500) }),
      }),
    );
  }
}
