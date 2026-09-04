import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1788524532360 implements MigrationInterface {
    name = 'InitialSchema1788524532360'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users"  ("email") `);
        await queryRunner.query(`CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "originalPrice" numeric(10,2) NOT NULL, "description" text, "imageUrl" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."flash_sales_status_enum" AS ENUM('scheduled', 'active', 'ended', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "flash_sales" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "product_id" uuid NOT NULL, "salePrice" numeric(10,2) NOT NULL, "totalStock" integer NOT NULL, "soldCount" integer NOT NULL DEFAULT '0', "status" "public"."flash_sales_status_enum" NOT NULL DEFAULT 'scheduled', "startTime" TIMESTAMP WITH TIME ZONE NOT NULL, "endTime" TIMESTAMP WITH TIME ZONE NOT NULL, "maxPerUser" integer NOT NULL DEFAULT '1', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_70299593044ffcba05cc30b97dc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'processing', 'confirmed', 'failed')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "flashSaleId" uuid NOT NULL, "productId" uuid NOT NULL, "quantity" integer NOT NULL, "totalAmount" numeric(10,2) NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending', "failureReason" character varying, "jobId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ee335ef37caf1a65d66481c6ed" ON "orders"  ("userId", "flashSaleId") `);
        await queryRunner.query(`ALTER TABLE "flash_sales" ADD CONSTRAINT "FK_68e8572774fc097c535d6441c94" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_4752097fceaa99b87b4ea22d763" FOREIGN KEY ("flashSaleId") REFERENCES "flash_sales"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_8624dad595ae567818ad9983b33" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_8624dad595ae567818ad9983b33"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_4752097fceaa99b87b4ea22d763"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1"`);
        await queryRunner.query(`ALTER TABLE "flash_sales" DROP CONSTRAINT "FK_68e8572774fc097c535d6441c94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ee335ef37caf1a65d66481c6ed"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
        await queryRunner.query(`DROP TABLE "flash_sales"`);
        await queryRunner.query(`DROP TYPE "public"."flash_sales_status_enum"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
