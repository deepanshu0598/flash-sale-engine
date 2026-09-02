import { IsUUID, IsNumber, IsInt, IsDateString, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSaleDto {
  @IsUUID()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  salePrice: number;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  totalStock: number;

  @IsDateString()
  startTime: string;

  @IsDateString()
  endTime: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  maxPerUser?: number;
}
