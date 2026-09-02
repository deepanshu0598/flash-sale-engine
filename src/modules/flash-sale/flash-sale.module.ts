import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlashSale } from './entities/flash-sale.entity.js';
import { FlashSaleService } from './flash-sale.service.js';
import { FlashSaleController } from './flash-sale.controller.js';
import { ProductModule } from '../product/product.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlashSale]),
    ProductModule,
  ],
  controllers: [FlashSaleController],
  providers: [FlashSaleService],
  exports: [FlashSaleService],
})
export class FlashSaleModule {}
