import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWebhookFieldsToFlashSale1788526171383 implements MigrationInterface {
    name = 'AddWebhookFieldsToFlashSale1788526171383'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flash_sales" ADD "webhookUrl" character varying`);
        await queryRunner.query(`ALTER TABLE "flash_sales" ADD "webhookSecret" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flash_sales" DROP COLUMN "webhookSecret"`);
        await queryRunner.query(`ALTER TABLE "flash_sales" DROP COLUMN "webhookUrl"`);
    }

}
