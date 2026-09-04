import { Controller, Get, Param, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiNotFoundResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { OrderService } from './order.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { User } from '../user/entities/user.entity.js';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated user's orders" })
  @ApiResponse({ status: 200, description: 'Array of orders, most recent first' })
  findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.orderService.findByUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order (status, jobId, failureReason)' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiForbiddenResponse({ description: 'Order belongs to a different user' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.orderService.findOne(id, user.id);
  }
}
