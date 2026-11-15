import {randomUUID,createHash} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeGuestAgreementDocumentAuthority} from "@/app/api/guest-hub/agreement/native-document-authority";
import {admitGuestAgreementSignatureReference,executeComposedSignatureDistributionReference} from "@/app/api/guest-hub/agreement/native-signature-distribution";
import {nativeGuestAgreementPreparedFixture,completeOwnedNativeGuestAgreement} from "../../integration/support/guest-hub-agreement-fixture";
import type {ownedSignatureProvider} from "../../integration/support/document-signature-provider";
import {documentFixtureObjects} from "./document-fixture-objects";
import {signatureFixtureEnvironment} from "./signature-fixture-config";
import {storageFixtureEnvironment} from "./storage-fixture-config";

const database=new URL(process.env.DATABASE_URL??"invalid:");
if(!process.send||process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!(database.pathname==="/alvillas_automation_guest257_guest_agreement_20261115"||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os"))throw Error("Owned native agreement browser worker required");
const command=z.discriminatedUnion("type",[
 z.object({id:z.uuid(),type:z.literal("prepare"),origin:z.url(),organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),locale:z.enum(["en","fr","ar"])}).strict(),
 z.object({id:z.uuid(),type:z.literal("distribute"),requestId:z.uuid()}).strict(),
 z.object({id:z.uuid(),type:z.literal("complete")}).strict(),
 z.object({id:z.uuid(),type:z.literal("close")}).strict()
]),db=new PrismaClient(),providers:Array<Awaited<ReturnType<typeof ownedSignatureProvider>>>=[],env={...process.env,...signatureFixtureEnvironment,...storageFixtureEnvironment};
let original:Awaited<ReturnType<typeof nativeGuestAgreementPreparedFixture>>|null=null,objects:ReturnType<typeof documentFixtureObjects>|null=null,busy=false;
const send=(id:string,value:unknown)=>process.send?.({id,ok:true,value}),sends=()=>original?.http.calls.filter(call=>call.method==="POST"&&call.path==="/api/v2/envelope/distribute").length??0;
async function close(){for(const provider of providers)await provider.close();await db.$disconnect();}
async function execute(raw:unknown){const input=command.parse(raw);if(busy)throw Error("One original fixture phase at a time is required");busy=true;try{
 if(input.type==="close"){await close();send(input.id,{});process.disconnect?.();return;}
 if(input.type==="prepare"){
  if(original)throw Error("An original native fixture already exists");objects=documentFixtureObjects(input.origin,{write:true});const locale=input.locale==="ar"?"fr":input.locale;original=await nativeGuestAgreementPreparedFixture(db,db,env,objects,locale,providers,{identity:{organizationId:input.organizationId,accountId:input.accountId,personId:input.personId,guestLocale:input.locale},provider:{port:3198,publicOrigin:signatureFixtureEnvironment.DOCUMENSO_URL},arabicFallbackLocale:"fr"});send(input.id,{organizationId:original.organizationId,propertyId:original.property.id,reservationId:original.reservation.id,preparationId:original.prepared.id,documentGrants:original.documentGrants,noticeTitle:original.policy.notice!.title.en});return;
 }
 if(!original||!objects)throw Error("The original prepared native fixture is required");const f=original,deps={db,env,objects,agreementDocuments:nativeGuestAgreementDocumentAuthority,provider:f.http.provider,providerOrigin:f.http.origin};
 if(input.type==="distribute"){
  const request=await withTenant(db,f.organizationId,tx=>tx.guestHubAgreementRequest.findFirstOrThrow({where:{id:input.requestId,reservationId:f.reservation.id,preparationId:f.prepared.id}})),child=await admitGuestAgreementSignatureReference({organizationId:f.organizationId,outboxEventId:request.outboxEventId},deps),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:"documents.signature.distribute_requested",payload:{path:["intentId"],equals:child.distributionIntentId}}})),reference={organizationId:f.organizationId,outboxEventId:event.id},first=await executeComposedSignatureDistributionReference(reference,deps),recovered=await executeComposedSignatureDistributionReference(reference,deps);if(first.state!=="SENT"||recovered.state!=="SENT"||sends()!==1)throw Error("One original native send and idempotent recovery required");send(input.id,{state:first.state,providerPosts:sends()});return;
 }
 if(sends()!==1)throw Error("An actual native send is required before owned completion");await completeOwnedNativeGuestAgreement(f,db,env,objects);if(!f.http.state.signedPdf||!f.http.state.certificatePdf)throw Error("Actual provider artifacts are required");const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");send(input.id,{signedSha256:digest(f.http.state.signedPdf),certificateSha256:digest(f.http.state.certificatePdf),providerPosts:sends()});
 }finally{busy=false;}}
process.on("message",(raw:unknown)=>{void execute(raw).catch(error=>{const id=z.object({id:z.uuid()}).safeParse(raw);process.stderr.write(JSON.stringify({errorName:error instanceof Error?error.name:"Error",frames:error instanceof Error?error.stack?.split("\n").filter(line=>/^\s*at /u.test(line)).slice(0,10):[]})+"\n");process.send?.({id:id.success?id.data.id:randomUUID(),ok:false,error:error instanceof Error?error.name:"Error"});});});
process.once("disconnect",()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
