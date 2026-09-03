import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { FlashSaleService } from './flash-sale.service.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PurchaseDto } from './dto/purchase.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';

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

  @Post(':id/purchase')
  @UseGuards(JwtAuthGuard)
  purchase(@Param('id') id: string, @Body() dto: PurchaseDto, @Req() req: Request) {
    const user = req.user as { id: string };
    return this.flashSaleService.purchase(user.id, id, dto);
  }
}
