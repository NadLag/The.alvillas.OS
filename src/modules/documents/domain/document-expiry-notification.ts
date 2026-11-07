import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource,authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";

/** Server-only target facts; notification input never accepts caller-supplied checks. */
export type DocumentExpiryNoticeResource = Resource & {
  documentExpiryAudienceId:string;
  documentExpiryVersionNumber:number;
  documentExpiryChecks:CurrentAuthorityCheck[];
};
export function canReadDocumentExpiryNotice(ctx:AuthContext,resource:Resource,now:Date){
  const target=resource as Partial<DocumentExpiryNoticeResource>;
  if(target.organizationId!==ctx.organizationId||target.type!=="document"||target.id!==target.documentId||!target.notificationEventId||target.documentExpiryAudienceId!==ctx.userAccountId||typeof target.documentExpiryVersionNumber!=="number"||!Number.isSafeInteger(target.documentExpiryVersionNumber)||target.documentExpiryVersionNumber<=0||!Array.isArray(target.documentExpiryChecks)||!target.documentExpiryChecks.length)return false;
  if(!target.documentExpiryChecks.some(check=>check.action==="view"&&check.resource.type==="document"&&check.resource.id===target.documentId))return false;
  return target.documentExpiryChecks.every(check=>check.resource.organizationId===ctx.organizationId&&(check.organizationOnly?authorizeOrganizationSource:check.unconditional?authorizeUnconditionalSource:authorize)(ctx,check.action,check.resource,now));
}
