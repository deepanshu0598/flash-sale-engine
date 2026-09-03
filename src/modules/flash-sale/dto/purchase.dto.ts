import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  quantity?: number = 1;
}
