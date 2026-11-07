import type { Prisma } from "@prisma/client";
import { SignaturePreparationRepository } from "./signature-preparation-repository";

export class SignatureWebhookRepository extends SignaturePreparationRepository {
  webhookEvidence(webhookId: string) { return this.tx.signatureProviderEvidence.findMany({ where: { organizationId: this.organizationId, webhookId }, orderBy: [{ observedAt: "asc" }, { id: "asc" }] }); }
  webhook(id: string) { return this.tx.signatureProviderWebhook.findFirst({ where: { organizationId: this.organizationId, id } }); }
  webhookByEvent(providerScopeHash: string, providerEventId: string) { return this.tx.signatureProviderWebhook.findFirst({ where: { organizationId: this.organizationId, providerScopeHash, providerEventId } }); }
  preparedProviderBinding(providerScopeHash: string, providerRequestId: string) { return this.tx.signatureProviderEvidence.findFirst({ where: { organizationId: this.organizationId, providerScopeHash, providerRequestId, phase: "PREPARE", kind: "PREPARED" }, include: { attempt: true } }); }
  appendWebhook(data: Omit<Prisma.SignatureProviderWebhookUncheckedCreateInput, "organizationId">) { return this.tx.signatureProviderWebhook.create({ data: { ...data, organizationId: this.organizationId } }); }
}
