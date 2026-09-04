import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { ORDER_DLQ, DEAD_ORDER_JOB } from './queue.constants.js';

interface DeadOrderJobData {
  orderId: string;
  userId: string;
  saleId: string;
  quantity: number;
  amount: number;
  failureReason: string;
  originalJobId: string | number;
}

// Jobs land here only after OrderProcessor has exhausted all retry attempts —
// this is the "needs a human" queue. It doesn't reprocess anything itself;
// it exists to make exhausted failures loud and inspectable in Bull Board
// (/queues) instead of silently sitting in the main queue's failed list.
@Processor(ORDER_DLQ)
export class DlqProcessor {
  private readonly logger = new Logger(DlqProcessor.name);

  @Process(DEAD_ORDER_JOB)
  async handle(job: Job<DeadOrderJobData>): Promise<void> {
    // Swap this log line for a webhook/Slack/PagerDuty call in production —
    // this is the single choke point where that alert would be wired in.
    this.logger.error(
      `DEAD LETTER: order ${job.data.orderId} (sale ${job.data.saleId}) exhausted all retries ` +
      `and needs manual review — reason: ${job.data.failureReason}`,
    );
  }
}
