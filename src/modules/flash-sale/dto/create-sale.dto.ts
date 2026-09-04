import { IsUUID, IsNumber, IsInt, IsDateString, IsOptional, IsUrl, Min } from 'class-validator';
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

  // If set, a webhookSecret is generated server-side and returned once in
  // the create() response — the caller uses it to verify the HMAC signature
  // on incoming order-confirmed callbacks (see order.processor.ts).
  @IsUrl({ require_tld: false })
  @IsOptional()
  webhookUrl?: string;
}
