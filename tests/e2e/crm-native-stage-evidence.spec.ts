import {randomUUID} from "node:crypto";
import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {leadStages,leadPipelineEvidenceKinds,type LeadStageDraft,type LeadPipelinePolicy} from "@/modules/crm/domain/lead-pipeline";
import {nativeLeadConversionBrowserFlow} from "./support/crm-conversion-browser-flow";
import type {LeadContractBrowserContext} from "./support/crm-contract-browser-flow";
import {acknowledgementBarrier} from "./support/acknowledgement-barrier";
import {forwardBrowserPostOnce} from "./support/forward-browser-post";
import {privateNativeLeadBrowserStorage} from "./support/crm-document-fixtures";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};

const messages={en,fr,ar};
type Flow=LeadContractBrowserContext&{pipeline:LeadPipelinePolicy;references:NonNullable<LeadStageDraft["evidenceReferences"]>};
async function advance(flow:Flow,toStage:LeadStageDraft["toStage"],releaseBlocked=false){
 const{page,db,f,locale,pipeline,references}=flow,before=await withTenant(db,bootstrapOrganizationId,tx=>tx.leadStageRevision.findFirst({where:{leadId:f.lead.id},orderBy:{number:"desc"}})),edge=pipeline.transitions.find(edge=>edge.from===(before?.toStage??"NEW")&&edge.to===toStage);expect(edge).toBeTruthy();if(!edge)throw Error("Actual approved transition required");
 const editor=page.getByTestId("lead-stage-editor");await editor.locator('select[name="nextStage"]').selectOption(toStage);
 for(const kind of leadPipelineEvidenceKinds.filter(kind=>edge.evidence.includes(kind))){
  await editor.getByTestId("lead-stage-find-evidence").click();const choices=editor.getByTestId("lead-stage-evidence-choices");await expect(choices).toBeVisible();
  if(kind==="ONBOARDING_RELEASE"){expect(releaseBlocked).toBe(true);await expect(choices).toContainText(messages[locale].LeadWorkspace.evidence.onboardingRequired);await expect(editor.getByRole("button",{name:messages[locale].LeadWorkspace.advanceStage,exact:true})).toBeDisabled();expect(await withTenant(db,bootstrapOrganizationId,tx=>tx.leadStageRevision.count({where:{leadId:f.lead.id,toStage:"GO_LIVE"}}))).toBe(0);return before!.id;}
  if(kind==="PROPOSAL_VERSION"||kind==="CONTRACT_VERSION"||kind==="SIGNATURE_SENT"){await choices.getByTestId("lead-stage-evidence-choice").first().click();await expect(choices.getByTestId("lead-stage-evidence-choice")).toHaveCount(1);}
  await choices.getByTestId("lead-stage-evidence-choice").first().click();await expect(editor.getByTestId("lead-stage-evidence-choices")).toHaveCount(0);
 }
 if(edge.evidence.length)await expect(editor.getByTestId("lead-stage-evidence-complete")).toBeVisible();
 const reason="PRIVATE-NATIVE-STAGE-"+toStage+"-"+randomUUID();await editor.locator('textarea[name="stageReason"]').fill(reason);await editor.getByRole("button",{name:messages[locale].LeadWorkspace.advanceStage,exact:true}).click();await expect(page.getByTestId("lead-review")).toBeVisible();
 let admissions=0;const acknowledgement=acknowledgementBarrier();if(toStage==="SIGNED")await page.route("**/api/crm/leads/stages/admit",async route=>{try{admissions++;expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();acknowledgement.resolve();}catch(error){acknowledgement.reject(error);throw error;}});
 await page.getByRole("button",{name:messages[locale].LeadWorkspace.confirmStage,exact:true}).click();
 if(toStage==="SIGNED"){
  await acknowledgement.promise;await expect(page.getByTestId("lead-recover-stage")).toBeEnabled();await page.unroute("**/api/crm/leads/stages/admit");const saved=await withTenant(db,bootstrapOrganizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{leadId:f.lead.id,toStage:"SIGNED"},orderBy:{number:"desc"}})),nonceKey="alvillas.crm.stage."+f.scope;
  expect(admissions).toBe(1);expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBe(saved.commandKey);await page.reload();await page.getByTestId("lead-recover-stage").click();await expect(page.getByTestId("lead-status")).toContainText(messages[locale].LeadWorkspace.states.saved);expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBeNull();
 }
 await expect(page.getByTestId("lead-review")).toHaveCount(0);await expect(page.getByTestId("lead-current-details")).toBeVisible();const saved=await withTenant(db,bootstrapOrganizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{leadId:f.lead.id},orderBy:{number:"desc"}}));expect(saved.toStage).toBe(toStage);expect(saved.previousId).toBe(before?.id??null);expect(saved.number).toBe((before?.number??0)+1);const proofs=z.array(z.object({kind:z.enum(leadPipelineEvidenceKinds),sourceId:z.uuid()}).passthrough()).parse(saved.evidence);expect(proofs.map(({kind,sourceId})=>({kind,sourceId}))).toEqual(references.filter(reference=>edge.evidence.includes(reference.kind)));
 for(const privateValue of[f.owner,f.input.fields.email!,reason])expect(await privateNativeLeadBrowserStorage(page)).not.toContain(privateValue);return saved.id;
}

for(const locale of["en","fr","ar"]as const)test("Actual native pipeline selects approved documents and signing records, recovers one stage command and keeps release closed in "+locale,async({page,context},info)=>{
 let approved:Flow|undefined;
 await nativeLeadConversionBrowserFlow(page,context,locale,info,"CREATE",{
  advancePipeline:async value=>{approved=value;await page.goto(`/${locale}/app/crm?lead=${value.f.lead.id}`);await expect(page.getByTestId("lead-current-details")).toBeVisible();let signed:string|undefined;for(const stage of leadStages.slice(1,9))signed=await advance(value,stage);if(!signed)throw Error("Actual UI signed stage required");return signed;},
  afterConversion:async value=>{if(!approved)throw Error("Actual native pipeline must precede conversion");const flow={...approved,...value,references:[...approved.references,{kind:"OWNER_CONVERSION"as const,sourceId:value.conversion.id}]};await advance(flow,"ALVILLAS_ONBOARDING");await advance(flow,"GO_LIVE",true);await page.setViewportSize({width:360,height:800});await expect.poll(()=>page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))).toEqual({width:360,scroll:360});expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);await page.screenshot({path:info.outputPath("actual-native-stage-evidence-"+locale+"-360.png"),fullPage:true});}
 });
});
