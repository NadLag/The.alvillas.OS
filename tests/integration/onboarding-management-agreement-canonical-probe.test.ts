import {randomBytes,randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {PrismaClient} from "@prisma/client";
import {afterAll,expect,it,vi} from "vitest";
import {nativeOnboardingManagementAgreementFixture} from "./support/onboarding-management-agreement-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import {reviewOnboardingManagementAgreementStep,admitOnboardingManagementAgreementStep} from "@/modules/onboarding/application/onboarding-service";
import * as envelope from "@/modules/onboarding/domain/onboarding-management-agreement-payload";
import {nativeOnboardingManagementAgreementRuleValues} from "@/platform/onboarding/contracts";
import {parseConfigRuleValue} from "@/platform/config/rule-registry";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";

let admin:PrismaClient,db:PrismaClient,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>;
const organizations:string[]=[];
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{vi.restoreAllMocks();await db?.$disconnect();await admin?.$disconnect();}});
it("compares actual canonical Core creation metadata before authenticated original-envelope validation",async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_crm_proposal_onboarding")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned native diagnostic database required");admin=new PrismaClient({datasourceUrl:value});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});financial=await nativeLeadFinancialGuard(admin,db);const env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"canonical-probe:"+randomBytes(32).toString("base64")},f=await nativeOnboardingManagementAgreementFixture(admin,db,env),draft={...f.draft,target:{mode:"CREATE",propertyId:f.agreement.propertyId,input:{...f.terms,reference:"Actual canonical source probe "+randomUUID()}}},review=await reviewOnboardingManagementAgreementStep(f.ctx,draft,f.deps),original=envelope.encryptOnboardingManagementAgreementPayload;
 organizations.push(f.organizationId);
 vi.spyOn(envelope,"encryptOnboardingManagementAgreementPayload").mockImplementation((raw,binding,settings)=>{if(raw.command.target.mode!=="CREATE")throw Error("Actual CREATE observation required");const input=raw.command.target.input,expected=nativeOnboardingManagementAgreementRuleValues({...input,approvalThresholdKey:input.approvalThresholdKey??undefined,approvalThresholdAmount:input.approvalThresholdAmount??undefined}).map(rule=>({...rule,value:parseConfigRuleValue(rule.key,rule.value)})),actual=raw.originalAgreement;const observed={previousIsNull:raw.previousAgreement===null,statusIsDraft:actual.status==="DRAFT",referenceMatches:actual.reference===input.reference,startMatches:actual.effectiveFrom===input.effectiveFrom,endMatches:actual.effectiveTo===input.effectiveTo,rules:actual.rules.map(rule=>({key:rule.key,version:rule.version,lifecycle:rule.lifecycle,startMatches:rule.effectiveFrom===input.effectiveFrom,endMatches:rule.effectiveTo===input.effectiveTo,reasonMatches:rule.reason===raw.command.reason,valueMatches:isDeepStrictEqual(rule.value,expected.find(value=>value.key===rule.key)?.value),serializedValueMatches:commandFingerprint(rule.value)===commandFingerprint(expected.find(value=>value.key===rule.key)?.value)}))};console.log(JSON.stringify({actualCanonicalEnvelopeComparison:observed}));expect(observed.previousIsNull&&observed.statusIsDraft&&observed.referenceMatches&&observed.startMatches&&observed.endMatches).toBe(true);expect(observed.rules.every(rule=>rule.version===1&&rule.lifecycle==="DRAFT"&&rule.startMatches&&rule.endMatches&&rule.reasonMatches&&rule.valueMatches)).toBe(true);return original(raw,binding,settings);});
 expect((await admitOnboardingManagementAgreementStep(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual canonical rule metadata observation"},f.deps)).step).toBe("MANAGEMENT_AGREEMENT");
});
