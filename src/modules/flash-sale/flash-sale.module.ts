import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { BullModule } from '@nestjs/bull';
import { FlashSale } from './entities/flash-sale.entity.js';
import { FlashSaleService } from './flash-sale.service.js';
import { FlashSaleController } from './flash-sale.controller.js';
import { ProductModule } from '../product/product.module.js';
import { Order } from '../order/entities/order.entity.js';
import { ORDER_QUEUE } from '../queue/queue.constants.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlashSale, Order]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    BullModule.registerQueue({ name: ORDER_QUEUE }),
    ProductModule,
  ],
  controllers: [FlashSaleController],
  providers: [FlashSaleService],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
