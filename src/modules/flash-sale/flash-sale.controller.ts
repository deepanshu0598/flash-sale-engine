import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  Headers,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { FlashSaleService } from './flash-sale.service.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PurchaseDto } from './dto/purchase.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PurchaseRateLimitGuard } from '../../common/guards/purchase-rate-limit.guard.js';

@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSaleController {
  constructor(private readonly flashSaleService: FlashSaleService) {}

  @Get()
  @ApiOperation({ summary: 'List all sales with live Redis stock' })
  @ApiResponse({ status: 200, description: 'Array of sales (webhookSecret never included)' })
  findAll() {
    return this.flashSaleService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single sale with live stock' })
  @ApiResponse({ status: 200, description: 'Sale found' })
  @ApiNotFoundResponse({ description: 'Sale not found' })
  findOne(@Param('id') id: string) {
    return this.flashSaleService.findOne(id);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Live stock, sold count, and time remaining — pure Redis, no DB hit' })
  @ApiResponse({ status: 200, description: 'Live status' })
  @ApiNotFoundResponse({ description: 'Sale not found' })
  status(@Param('id') id: string) {
    return this.flashSaleService.getStatus(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a flash sale and initialize its Redis inventory' })
  @ApiResponse({
    status: 201,
    description: 'Sale created. If webhookUrl was set, webhookSecret is returned once here — save it, it is never shown again.',
  })
  @ApiBadRequestResponse({ description: 'endTime is not after startTime, or DTO validation failed' })
  create(@Body() dto: CreateSaleDto) {
    return this.flashSaleService.create(dto);
  }

  @Post(':id/purchase')
  @UseGuards(JwtAuthGuard, PurchaseRateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Purchase from a flash sale — the core lock-free atomic endpoint' })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: false,
    description: 'Optional. A duplicate request with the same key returns the original result instead of purchasing again.',
  })
  @ApiResponse({ status: 201, description: 'Purchase accepted — returns { orderId, jobId }. Confirmation happens async.' })
  @ApiBadRequestResponse({ description: 'Sale not active/started/ended, or per-user limit exceeded' })
  @ApiConflictResponse({ description: 'Sold out, or a request with this idempotency key is already in progress' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded (5 req/10s per user, 20 req/10s per IP)' })
  purchase(
    @Param('id') id: string,
    @Body() dto: PurchaseDto,
    @Req() req: Request,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    const user = req.user as { id: string };
    return this.flashSaleService.purchase(user.id, id, dto, idempotencyKey);
  }
}
