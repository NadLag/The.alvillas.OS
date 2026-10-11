export type AuditEvent = {
  organizationId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress?: string | null;
  deviceId?: string | null;
  propertyScopeId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId: string;
  occurredAt: Date;
};
