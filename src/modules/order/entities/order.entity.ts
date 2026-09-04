import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../user/entities/user.entity.js';
import { FlashSale } from '../../flash-sale/entities/flash-sale.entity.js';
import { Product } from '../../product/entities/product.entity.js';

export enum OrderStatus {
  PENDING    = 'pending',
  PROCESSING = 'processing',
  CONFIRMED  = 'confirmed',
  FAILED     = 'failed',
}

@Entity('orders')
@Index(['userId', 'flashSaleId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => FlashSale)
  @JoinColumn({ name: 'flashSaleId' })
  flashSale: FlashSale;

  @Column('uuid')
  flashSaleId: string;

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'productId' })
  product: Product;

  @Column('uuid')
  productId: string;

  @Column('int')
  quantity: number;

  @Column('decimal', { precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ nullable: true })
  failureReason: string;

  @Column({ nullable: true })
  jobId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
