import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { ORDER_QUEUE } from './queue.constants.js';

// @nestjs/bull does not close its queues on shutdown by itself — without this,
// app.enableShutdownHooks() (main.ts) closes everything else gracefully but
// leaves the order queue's Redis connection to die mid-job. queue.close()
// waits for the currently active job to finish before resolving, so an
// in-flight payment simulation / DB update isn't cut off by SIGTERM.
@Injectable()
export class QueueShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueShutdownService.name);

  constructor(
    @InjectQueue(ORDER_QUEUE)
    private readonly orderQueue: Queue,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Received ${signal ?? 'shutdown'} — draining ${ORDER_QUEUE} before exit`);
    await this.orderQueue.close();
  }
}
