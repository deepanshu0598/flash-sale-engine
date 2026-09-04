import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../order/entities/order.entity.js';
import { FlashSale } from '../flash-sale/entities/flash-sale.entity.js';
import { OrderProcessor } from './order.processor.js';
import { QueueShutdownService } from './queue-shutdown.service.js';
import { ORDER_QUEUE } from './queue.constants.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, FlashSale]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useFactory: (config: ConfigService): any => ({
        redis: {
          host: config.get<string>('redis.host') ?? 'localhost',
          port: config.get<number>('redis.port') ?? 6379,
        },
      }),
    }),
    BullModule.registerQueue({ name: ORDER_QUEUE }),
  ],
  providers: [OrderProcessor, QueueShutdownService],
  exports: [BullModule],
})
export class QueueModule {}
