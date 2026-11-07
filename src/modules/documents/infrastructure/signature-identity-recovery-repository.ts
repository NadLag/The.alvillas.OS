import type { Prisma } from "@prisma/client";
import { SignatureWebhookRepository } from "./signature-webhook-repository";

const include = { evidence: { orderBy: [{ observedAt: "asc" }, { id: "asc" }] } } satisfies Prisma.SignatureProviderIdentityRecoveryInclude;
export class SignatureIdentityRecoveryRepository extends SignatureWebhookRepository {
  identityRecovery(id: string) { return this.tx.signatureProviderIdentityRecovery.findFirst({ where: { organizationId: this.organizationId, id }, include }); }
  identityRecoveryByNonce(requestedBy: string, commandKey: string) { return this.tx.signatureProviderIdentityRecovery.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, include }); }
  identityRecoveryNonceOwner(commandKey: string) { return this.tx.signatureProviderIdentityRecovery.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }); }
  appendIdentityRecovery(data: Omit<Prisma.SignatureProviderIdentityRecoveryUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderIdentityRecovery.create({ data: { ...data, organizationId: this.organizationId }, include }); }
  async pendingIdentityCandidates(signatureId: string, before?: string) {
    const anchor = before ? await this.tx.signatureProviderWebhook.findFirst({ where: { organizationId: this.organizationId, signatureId, id: before }, select: { id: true, receivedAt: true } }) : null; if (before && !anchor) return null;
    return this.tx.signatureProviderWebhook.findMany({ where: { organizationId: this.organizationId, signatureId, ...anchor ? { OR: [{ receivedAt: { lt: anchor.receivedAt } }, { receivedAt: anchor.receivedAt, id: { lt: anchor.id } }] } : {} }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 31, select: { id: true, preparationAttemptId: true, providerScopeHash: true, providerRequestId: true, occurredAt: true, receivedAt: true } });
  }
}
