import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { FlashSaleService } from './flash-sale.service.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';

@Controller('flash-sales')
export class FlashSaleController {
  constructor(private readonly flashSaleService: FlashSaleService) {}

  @Get()
  findAll() {
    return this.flashSaleService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.flashSaleService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateSaleDto) {
    return this.flashSaleService.create(dto);
  }
}
