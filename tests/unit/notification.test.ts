import { describe, expect, it } from "vitest";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { notificationDestination, notificationInputSchema, notificationPageSchema, ownNotificationContext } from "@/platform/notifications/notification";

const org = "018f0a0b-0000-7000-9000-000000000001";
const account = "018f0a0b-0000-7000-9000-000000000002";
const task = "018f0a0b-0000-7000-9000-000000000003";
const context = (): AuthContext => ownNotificationContext({ organizationId: org, permissions: new Set(), scopes: [{ organizationId: org }] }, account);
const resource: Resource = { type: "task", organizationId: org, id: task, propertyId: "property-a", assignedUserAccountId: account };
const input = { kind: "task_assigned" as const, recipientId: account, targetId: task };

describe("personal notification permissions and safe destinations", () => {
  it("opens an emergency notice only through the recipient's current financial expense view scope", () => {
    const scope={organizationId:org,scopeType:"owner" as const,scopeId:"owner-a"},permissions=new Set(["expense:view"]);
    const ctx=ownNotificationContext({organizationId:org,permissions,scopes:[scope],assignments:[{scope,permissions,conditions:{maxAmount:"600"}}]},account);
    const subject:Resource={type:"expense",organizationId:org,id:task,financialRecordId:task,ownerId:"owner-a",amount:"500.25",dataClass:"financial"};
    const notice={kind:"expense_emergency" as const,recipientId:account,targetId:task};
    for(const locale of ["en","fr","ar"] as const)expect(notificationDestination(ctx,notice,subject,locale)).toBe(`/${locale}/app/expenses/${task}`);
    for(const denied of [{...subject,ownerId:"owner-b"},{...subject,amount:"600.01"},{...subject,organizationId:task},{...subject,id:account},{...subject,type:"task"}])
      expect(notificationDestination(ctx,notice,denied,"en")).toBeNull();
    expect(notificationDestination(context(),notice,subject,"en")).toBeNull();
    expect(notificationDestination(ctx,{...notice,recipientId:task},subject,"en")).toBeNull();
    expect(authorize(ctx,"approve",subject)).toBe(false);
  });
  it("links a financial approval through its request ID while authorizing its distinct expense source", () => {
    const approvalId = "018f0a0b-0000-7000-9000-000000000004", expenseId = "018f0a0b-0000-7000-9000-000000000005";
    const scope = { organizationId: org, scopeType: "owner" as const, scopeId: "owner-a" }, permissions = new Set(["expense:view"]);
    const ctx = ownNotificationContext({ organizationId: org, permissions, scopes: [scope], assignments: [{ scope, permissions }] }, account);
    const subject: Resource = { type: "expense", organizationId: org, id: expenseId, financialRecordId: expenseId, approvalId, ownerId: "owner-a", amount: "500.25", dataClass: "financial" };
    const notice = { kind: "approval_requested" as const, recipientId: account, targetId: approvalId };
    expect(notificationDestination(ctx, notice, subject, "fr")).toBe(`/fr/app/approvals/${approvalId}`);
    for (const denied of [{ ...subject, ownerId: "owner-b" }, { ...subject, approvalId: expenseId }, { ...subject, approvalId: undefined }])
      expect(notificationDestination(ctx, notice, denied, "fr")).toBeNull();
    expect(notificationDestination(context(), notice, subject, "fr")).toBeNull();
  });
  it("grants only the account inbox and never other inboxes, collections or tenants", () => {
    const ctx = context();
    expect(authorize(ctx, "view", { type: "notification", organizationId: org, id: account })).toBe(true);
    expect(authorize(ctx, "edit", { type: "notification", organizationId: org, id: account })).toBe(true);
    for (const denied of [{ type: "notification", organizationId: org }, { type: "notification", organizationId: org, id: task }, { type: "notification", organizationId: task, id: account }]) {
      expect(authorize(ctx, "view", denied)).toBe(false);
    }
    expect(authorize(ctx, "view", resource)).toBe(false);
  });
  it("checks current task permissions, scope, assignment and tenant before generating any URL", () => {
    const scope = { organizationId: org, scopeType: "property" as const, scopeId: "property-a" };
    const ctx = ownNotificationContext({ organizationId: org, permissions: new Set(["task:view"]), scopes: [scope],
      assignments: [{ scope, permissions: new Set(["task:view"]), conditions: { assignedToMe: true } }] }, account);
    expect(notificationDestination(ctx, input, resource, "fr")).toBe(`/fr/app/field/${task}`);
    for (const target of [null, { ...resource, organizationId: task }, { ...resource, propertyId: "property-b" }, { ...resource, assignedUserAccountId: task }, { ...resource, id: account }]) {
      expect(notificationDestination(ctx, input, target, "en")).toBeNull();
    }
    expect(notificationDestination(context(), input, resource, "en")).toBeNull();
    expect(notificationDestination(ctx, { ...input, recipientId: task }, resource, "en")).toBeNull();
  });
  it("allows own language record only without granting identity administration", () => {
    const ctx = context();
    expect(notificationDestination(ctx, { kind: "language_updated", recipientId: account, targetId: account }, { type: "identity", organizationId: org, id: account }, "ar")).toBe("/ar/app");
    expect(notificationDestination(ctx, { kind: "language_updated", recipientId: account, targetId: task }, { type: "identity", organizationId: org, id: task }, "en")).toBeNull();
    expect(authorize(ctx, "configure", { type: "identity", organizationId: org })).toBe(false);
  });
  it("binds a staff reminder to its document while authorizing the staff profile scope", () => {
    const person = "018f0a0b-0000-7000-9000-000000000004";
    const document = "018f0a0b-0000-7000-9000-000000000005";
    const scope = { organizationId: org, resourceType: "staff_document", resourceId: person };
    const ctx = ownNotificationContext({ organizationId: org, personId: person, permissions: new Set(["staff_document:view"]), scopes: [scope] }, account);
    const reminder = { kind: "staff_document_expiring" as const, recipientId: account, targetId: document };
    const target = { type: "staff_document", organizationId: org, id: person, documentId: document, assignedPersonId: person };
    expect(notificationDestination(ctx, reminder, target, "fr")).toBe(`/fr/app/team/${person}`);
    for (const denied of [
      { ...target, documentId: task },
      { ...target, id: task },
      { ...target, assignedPersonId: task },
      { ...target, assignedPersonId: undefined },
      { ...target, organizationId: task },
      { ...target, type: "task" }
    ]) expect(notificationDestination(ctx, reminder, denied, "en")).toBeNull();
    expect(notificationDestination(ctx, { ...reminder, recipientId: task }, target, "en")).toBeNull();
    expect(notificationDestination(context(), reminder, target, "en")).toBeNull();
  });
  it("never turns a mismatched document subject into a link under an organization grant", () => {
    const ctx = ownNotificationContext({ organizationId: org, permissions: new Set(["staff_document:view"]), scopes: [{ organizationId: org }] }, account);
    const reminder = { kind: "staff_document_expiring" as const, recipientId: account, targetId: task };
    expect(notificationDestination(ctx, reminder, { type: "staff_document", organizationId: org, id: account, documentId: task, assignedPersonId: org }, "en")).toBeNull();
  });
  it("rejects arbitrary URLs, message payloads and unbounded pagination input", () => {
    expect(notificationInputSchema.safeParse({ ...input, href: "https://example.test" }).success).toBe(false);
    expect(notificationInputSchema.safeParse({ ...input, kind: "financial_update" }).success).toBe(false);
    expect(notificationPageSchema.safeParse({ limit: 100000 }).success).toBe(false);
    expect(notificationPageSchema.safeParse({ cursor: { id: "invalid", createdAt: "yesterday" } }).success).toBe(false);
  });
});
