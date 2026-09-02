import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Product } from '../../product/entities/product.entity.js';

export enum SaleStatus {
  SCHEDULED = 'scheduled',
  ACTIVE    = 'active',
  ENDED     = 'ended',
  CANCELLED = 'cancelled',
}

@Entity('flash_sales')
export class FlashSale {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ name: 'product_id' })
  productId: string;

  @Column('decimal', { precision: 10, scale: 2 })
  salePrice: number;

  @Column('int')
  totalStock: number;

  @Column('int', { default: 0 })
  soldCount: number;

  @Column({ type: 'enum', enum: SaleStatus, default: SaleStatus.SCHEDULED })
  status: SaleStatus;

  @Column({ type: 'timestamptz' })
  startTime: Date;

  @Column({ type: 'timestamptz' })
  endTime: Date;

  @Column({ default: 1 })
  maxPerUser: number;

  @CreateDateColumn()
  createdAt: Date;
}
