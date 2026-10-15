export const outboxDispatchEvent = "alvillas/outbox.dispatch.requested";
export type OutboxEventStatus = "PENDING" | "DISPATCHED" | "FAILED";

export type OutboxEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  organizationId: string;
  type: string;
  payload: TPayload;
  idempotencyKey: string;
  status: OutboxEventStatus;
  occurredAt: Date;
};
