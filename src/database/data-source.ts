import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
config();

import { User } from '../modules/user/entities/user.entity.js';
import { Product } from '../modules/product/entities/product.entity.js';
import { FlashSale } from '../modules/flash-sale/entities/flash-sale.entity.js';
import { Order } from '../modules/order/entities/order.entity.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'flashsale',
  password: process.env.DB_PASSWORD ?? 'flashsale123',
  database: process.env.DB_NAME ?? 'flash_sale_db',
  entities: [User, Product, FlashSale, Order],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: false,
});
