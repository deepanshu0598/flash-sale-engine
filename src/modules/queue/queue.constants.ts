export const ORDER_QUEUE = 'order-queue';
export const PROCESS_ORDER_JOB = 'process-order';

export const ORDER_DLQ = 'order-dlq';
export const DEAD_ORDER_JOB = 'dead-order';

// Reuses ORDER_QUEUE — a distinct job name, not a distinct queue, since the
// reconciliation scheduler needs the same order-processing repository/queue
// wiring the main processor already has.
export const RECONCILE_SALES_JOB = 'reconcile-sales';
export const RECONCILE_SCHEDULER_JOB_ID = 'sale-reconciliation-scheduler';
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export const STRANDED_ORDER_THRESHOLD_MS = 10 * 60 * 1000;
