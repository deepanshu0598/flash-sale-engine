import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FlashSale, SaleStatus } from './entities/flash-sale.entity.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { RedisService } from '../redis/redis.service.js';
import { ProductService } from '../product/product.service.js';

@Injectable()
export class FlashSaleService {
  constructor(
    @InjectRepository(FlashSale)
    private readonly saleRepo: Repository<FlashSale>,
    private readonly redis: RedisService,
    private readonly productService: ProductService,
  ) {}

  async create(dto: CreateSaleDto): Promise<FlashSale> {
    // Verify product exists before creating sale
    await this.productService.findOne(dto.productId);

    const startTime = new Date(dto.startTime);
    const endTime   = new Date(dto.endTime);

    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const sale = this.saleRepo.create({
      productId:  dto.productId,
      salePrice:  dto.salePrice,
      totalStock: dto.totalStock,
      startTime,
      endTime,
      maxPerUser: dto.maxPerUser ?? 1,
      status:     SaleStatus.ACTIVE,
    });

    const saved = await this.saleRepo.save(sale);

    // Initialize Redis inventory right after DB save
    await this.redis.initInventory(saved.id, saved.totalStock);

    return saved;
  }

  async findAll(): Promise<object[]> {
    const sales = await this.saleRepo.find({
      relations: { product: true },
      order: { createdAt: 'DESC' },
    });

    // Attach live stock from Redis for each sale
    return Promise.all(
      sales.map(async (sale) => ({
        ...sale,
        liveStock: await this.redis.getInventory(sale.id),
        liveSold:  await this.redis.getSoldCount(sale.id),
      })),
    );
  }

  async findOne(id: string): Promise<object> {
    const sale = await this.saleRepo.findOne({
      where: { id },
      relations: { product: true },
    });
    if (!sale) throw new NotFoundException('Flash sale not found');

    const liveStock = await this.redis.getInventory(id);
    const liveSold  = await this.redis.getSoldCount(id);

    return { ...sale, liveStock, liveSold };
  }

  async findOneEntity(id: string): Promise<FlashSale> {
    const sale = await this.saleRepo.findOne({ where: { id } });
    if (!sale) throw new NotFoundException('Flash sale not found');
    return sale;
  }
}
