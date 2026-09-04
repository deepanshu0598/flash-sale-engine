import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Wires SIGTERM/SIGINT to app.close(), which runs every module's
  // onModuleDestroy/onApplicationShutdown hook — Redis pool quit,
  // TypeORM connection close, and the order queue drain (see
  // QueueShutdownService) all happen before the process actually exits.
  // Without this, `docker compose down` / replica restarts kill the process
  // mid-request and mid-job instead of draining them.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Flash Sale Engine')
    .setDescription('High-concurrency flash sale API — lock-free atomic Redis Lua purchase, BullMQ async orders')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
