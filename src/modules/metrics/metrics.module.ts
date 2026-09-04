import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrometheusModule, makeCounterProvider, makeHistogramProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { PoolMetricsUpdaterService } from './pool-metrics-updater.service.js';
import {
  PURCHASES_TOTAL,
  HTTP_REQUEST_DURATION,
  ORDER_QUEUE_DEPTH,
  REDIS_POOL_CONNECTED,
  DB_POOL_TOTAL,
  DB_POOL_IDLE,
  DB_POOL_WAITING,
} from './metrics.constants.js';

// @Global + exported providers: FlashSaleService (a different module) injects
// purchasesTotal directly via @InjectMetric — this is the one metrics
// dependency worth being global for, since purchase() is the whole point of
// the app. Everything else here is consumed only within this module.
const purchasesTotalProvider = makeCounterProvider({
  name: PURCHASES_TOTAL,
  help: 'Purchase attempts by outcome',
  labelNames: ['result'], // success | sold_out | limit_exceeded | not_active | error
});

const httpDurationProvider = makeHistogramProvider({
  name: HTTP_REQUEST_DURATION,
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const queueDepthProvider = makeGaugeProvider({
  name: ORDER_QUEUE_DEPTH,
  help: 'order-queue job count by state',
  labelNames: ['state'], // waiting | active
});

const redisPoolProvider = makeGaugeProvider({
  name: REDIS_POOL_CONNECTED,
  help: 'Number of Redis pool connections currently ready (out of 5)',
});

const dbPoolTotalProvider = makeGaugeProvider({ name: DB_POOL_TOTAL, help: 'Total pg pool connections' });
const dbPoolIdleProvider  = makeGaugeProvider({ name: DB_POOL_IDLE,  help: 'Idle pg pool connections' });
const dbPoolWaitingProvider = makeGaugeProvider({ name: DB_POOL_WAITING, help: 'Requests waiting for a pg pool connection' });

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics', // scraped by docker/prometheus.yml
      defaultMetrics: { enabled: true }, // free process/Node.js metrics (CPU, memory, event loop lag, GC)
    }),
  ],
  providers: [
    purchasesTotalProvider,
    httpDurationProvider,
    queueDepthProvider,
    redisPoolProvider,
    dbPoolTotalProvider,
    dbPoolIdleProvider,
    dbPoolWaitingProvider,
    PoolMetricsUpdaterService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [purchasesTotalProvider],
})
export class MetricsModule {}
