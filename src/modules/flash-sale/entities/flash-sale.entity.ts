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

  // Caller-configured callback fired on order CONFIRMED (see order.processor.ts).
  // webhookSecret is generated server-side at sale creation and returned once
  // in the create() response — it must be stripped from every other read path
  // (findAll/findOne/getStatus) so it's never re-exposed after that.
  @Column({ type: 'varchar', nullable: true })
  webhookUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  webhookSecret: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
