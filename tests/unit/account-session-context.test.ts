import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/platform/authz/account-context",()=>({authContextForAccount:boundary.read}));
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { financeActorContextFromSession } from "@/modules/finance/application/finance-access";

const organizationId=randomUUID(),id=randomUUID(),personId=randomUUID(),permissions=new Set(["document:view"]);
const session=():Session=>({expires:"2030-01-01T00:00:00.000Z",user:{id,personId,organizationId,preferredLocale:"fr",sessionId:randomUUID(),securitySetupRequired:false,sessionRevoked:false}});
describe.each([["shared account",accountActorContextFromSession],["existing finance",financeActorContextFromSession]] as const)("%s session authority",(_label,context)=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.read.mockResolvedValue({organizationId,userAccountId:id,permissions,scopes:[{organizationId,scopeType:"organization"}]});});
  it("uses persisted account authority while preserving the actual session person",async()=>{
    const result=await context(session());expect(boundary.read).toHaveBeenCalledWith(organizationId,id,{});expect(result).toMatchObject({organizationId,actorId:id,authContext:{personId,userAccountId:id}});expect(result?.authContext.permissions).toBe(permissions);
  });
  it("rejects an absent session before reading grants",async()=>{expect(await context(null)).toBe(null);expect(boundary.read).not.toHaveBeenCalled();});
  it.each(["id","personId","organizationId"] as const)("rejects missing %s",async key=>{const value=session();value.user[key]="";expect(await context(value)).toBe(null);expect(boundary.read).not.toHaveBeenCalled();});
  it.each(["securitySetupRequired","sessionRevoked"] as const)("rejects %s before reading document or financial authority",async key=>{const value=session();value.user[key]=true;expect(await context(value)).toBe(null);expect(boundary.read).not.toHaveBeenCalled();});
});
