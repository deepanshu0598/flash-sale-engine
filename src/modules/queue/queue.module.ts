import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ORDER_QUEUE } from './queue.constants.js';

@Global()
@Module({
  imports: [
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
  exports: [BullModule],
})
export class QueueModule {}
