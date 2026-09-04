import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import appConfig from './config/app.config.js';
import databaseConfig from './config/database.config.js';
import redisConfig from './config/redis.config.js';
import { RedisModule } from './modules/redis/redis.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UserModule } from './modules/user/user.module.js';
import { ProductModule } from './modules/product/product.module.js';
import { FlashSaleModule } from './modules/flash-sale/flash-sale.module.js';
import { OrderModule } from './modules/order/order.module.js';
import { QueueModule } from './modules/queue/queue.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ORDER_QUEUE, ORDER_DLQ } from './modules/queue/queue.constants.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.name'),
        autoLoadEntities: true,
        // synchronize is dev/test convenience only — production schema changes
        // go through committed migrations (npm run migration:run), never auto-DDL.
        synchronize: config.get<string>('app.nodeEnv') !== 'production',
        migrations: ['dist/database/migrations/*.js'],
        migrationsRun: config.get<string>('app.nodeEnv') === 'production',
        extra: {
          max: 50,  // pg pool size: handles burst of concurrent INSERTs (default 10)
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    BullBoardModule.forRoot({ route: '/queues', adapter: ExpressAdapter }),
    BullBoardModule.forFeature({ name: ORDER_QUEUE, adapter: BullAdapter }),
    BullBoardModule.forFeature({ name: ORDER_DLQ, adapter: BullAdapter }),
    RedisModule,
    QueueModule,
    AuthModule,
    UserModule,
    ProductModule,
    FlashSaleModule,
    OrderModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
