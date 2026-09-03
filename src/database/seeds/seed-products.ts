import { faker } from '@faker-js/faker';
import type { DataSource } from 'typeorm';
import { Product } from '../../modules/product/entities/product.entity.js';

export async function seedProducts(dataSource: DataSource): Promise<Product[]> {
  const repo = dataSource.getRepository(Product);

  const products = Array.from({ length: 50 }, () => ({
    name: faker.commerce.productName(),
    originalPrice: parseFloat(faker.commerce.price({ min: 500, max: 50000 })),
    description: faker.commerce.productDescription(),
    imageUrl: faker.image.url({ width: 400, height: 400 }),
  }));

  const saved = await repo.save(products);
  console.log(`Seeded ${saved.length} products`);
  return saved;
}
