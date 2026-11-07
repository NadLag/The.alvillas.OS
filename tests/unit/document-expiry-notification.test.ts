import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/platform/authz/authorize";
import { canReadDocumentExpiryNotice, type DocumentExpiryNoticeResource } from "@/modules/documents/domain/document-expiry-notification";
import { notificationDestination, notificationInputSchema } from "@/platform/notifications/notification";
import { notificationRoutingSaveSchema } from "@/platform/notifications/notification-routing";
import { shouldDeliverNotification, defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";

const org=randomUUID(),actor=randomUUID(),documentId=randomUUID(),propertyId=randomUUID(),reminderId=randomUUID(),now=new Date(),scope={organizationId:org,scopeType:"organization" as const},keys=["document:view","property:view","property_finance:view"];
function context(permissions=keys):AuthContext{return{organizationId:org,userAccountId:actor,permissions:new Set(permissions),scopes:[scope],assignments:[{scope,permissions:new Set(permissions)}]};}
const target:DocumentExpiryNoticeResource={organizationId:org,type:"document",id:documentId,documentId,propertyId,dataClass:"financial",notificationEventId:reminderId,documentExpiryAudienceId:actor,documentExpiryVersionNumber:7,documentExpiryChecks:[{action:"view",resource:{organizationId:org,type:"document",id:documentId,documentId,propertyId,dataClass:"financial"}},{action:"view",resource:{organizationId:org,type:"property",id:propertyId,propertyId}},{action:"view",resource:{organizationId:org,type:"property_finance",propertyId,dataClass:"financial"}}]};
const input={kind:"document_expiring" as const,recipientId:actor,targetId:reminderId};
describe("source-bound private document expiry notices",()=>{
  it("retains every independent current source and financial grant",()=>expect(canReadDocumentExpiryNotice(context(),target,now)).toBe(true));
  it.each(keys)("denies a held caller without %s despite its own inbox",key=>expect(canReadDocumentExpiryNotice(context(keys.filter(value=>value!==key)),target,now)).toBe(false));
  it.each(["organizationId","documentId","documentExpiryAudienceId"]as const)("rejects substituted native %s",key=>expect(canReadDocumentExpiryNotice(context(),{...target,[key]:randomUUID()},now)).toBe(false));
  it.each([0,-1,1.1,Number.MAX_SAFE_INTEGER+1])("rejects invalid version number %s",number=>expect(canReadDocumentExpiryNotice(context(),{...target,documentExpiryVersionNumber:number},now)).toBe(false));
  it("rejects an empty or foreign check list and requires the actual document view",()=>{
    for(const checks of[[],target.documentExpiryChecks.slice(1),target.documentExpiryChecks.map(check=>({...check,resource:{...check.resource,organizationId:randomUUID()}}))])expect(canReadDocumentExpiryNotice(context(),{...target,documentExpiryChecks:checks},now)).toBe(false);
  });
  it("retains unconditional and organization-only source requirements",()=>{
    const ctx=context(),financial={...target.documentExpiryChecks[2].resource,amount:"0.50"},base={...target,documentExpiryChecks:[...target.documentExpiryChecks.slice(0,2),{action:"view" as const,resource:financial}]};ctx.assignments=[{scope,permissions:new Set(keys.slice(0,2))},{scope,permissions:new Set([keys[2]]),conditions:{maxAmount:"1.00"}}];
    expect(canReadDocumentExpiryNotice(ctx,base,now)).toBe(true);
    for(const check of[{organizationOnly:true},{unconditional:true}])expect(canReadDocumentExpiryNotice(ctx,{...base,documentExpiryChecks:[...base.documentExpiryChecks,{action:"view",resource:financial,...check}]},now)).toBe(false);
  });
  it("rejects expired held authority",()=>{const ctx=context();ctx.assignments=[{scope,permissions:new Set(keys),validTo:new Date(now.getTime()-1)}];expect(canReadDocumentExpiryNotice(ctx,target,now)).toBe(false);});
  it.each(["en","fr","ar"]as const)("resolves only the actual recipient and opaque immutable version in %s",locale=>{
    expect(notificationDestination(context(),input,target,locale)).toBe(`/${locale}/app/documents?document=${documentId}&version=7`);
    expect(notificationDestination(context(),{...input,recipientId:randomUUID()},target,locale)).toBeNull();expect(notificationDestination(context(),{...input,targetId:randomUUID()},target,locale)).toBeNull();expect(notificationDestination(context(),input,{...target,notificationEventId:randomUUID()},locale)).toBeNull();
  });
  it("accepts only native opaque notification references, never private titles or caller supplied checks",()=>{
    expect(notificationInputSchema.parse(input)).toEqual(input);for(const extra of[{title:"PRIVATE document"},{documentExpiryChecks:[]},{sourceUrl:"https://foreign.example.test/private"}])expect(notificationInputSchema.safeParse({...input,...extra}).success).toBe(false);
  });
  it("requires explicit organization routing and preserves account-channel consent",()=>{
    const routing={roles:[],people:[randomUUID()],assigned:false,channels:["in_app"]},save={kind:"document_expiring",propertyId:null,routing,reason:"Explicit private native expiry audience"};expect(notificationRoutingSaveSchema.safeParse(save).success).toBe(true);
    for(const invalid of[{...save,propertyId},{...save,routing:{...routing,assigned:true}},{...save,routing:{...routing,people:[]}},{...save,routing:{...routing,channels:[]}}])expect(notificationRoutingSaveSchema.safeParse(invalid).success).toBe(false);
    const preferences=defaultNotificationPreferences();expect(shouldDeliverNotification("document_expiring","in_app",preferences)).toBe(true);preferences.in_app.account=false;expect(shouldDeliverNotification("document_expiring","in_app",preferences)).toBe(false);expect(shouldDeliverNotification("document_expiring","email",preferences)).toBe(false);expect(shouldDeliverNotification("document_expiring","push",preferences)).toBe(false);
  });
});
