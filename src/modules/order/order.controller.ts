import { Controller, Get, Param, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrderService } from './order.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { User } from '../user/entities/user.entity.js';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.orderService.findByUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.orderService.findOne(id, user.id);
  }
}
