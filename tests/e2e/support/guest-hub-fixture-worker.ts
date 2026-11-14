import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {guestHubPresentationPolicyKey} from "@/modules/guest-hub/domain/guest-hub-presentation";
import {nativeGuestHubFixture} from "../../integration/support/guest-hub-fixture";
import {nativeGuestHubProfileFixture} from "../../integration/support/guest-hub-profile-fixture";
import {nativeGuestHubStayDetailsFixture} from "../../integration/support/guest-hub-stay-details-fixture";

const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1),profile:z.boolean().optional(),form:z.literal("STAY_DETAILS").optional()}).strict().parse(JSON.parse(process.argv[2]??"null")),database=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned migrated Guest Hub browser fixture process required");
const db=new PrismaClient();
try{
 const f=input.form==="STAY_DETAILS"?await nativeGuestHubStayDetailsFixture(db,db,{},input):input.profile?await nativeGuestHubProfileFixture(db,db,{},input):await nativeGuestHubFixture(db,db,{},input),names={en:"Actual guest villa ",fr:"Villa de séjour réelle ",ar:"فيلا الإقامة الفعلية "};const property=await withTenant(db,f.organizationId,async tx=>{const updated=await tx.property.update({where:{id:f.property.id},data:{name:names[input.guestLocale].repeat(7),photoUrls:["https://photos.example.test/actual-owned-guest-villa.png","https://photos.example.test/private.jpg?token=private-owned-photo"]}});await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:guestHubPresentationPolicyKey,scopeType:"property",scopeId:updated.id,createdBy:input.accountId,effectiveFrom:new Date("2020-01-01"),value:{source:"NATIVE_GUEST_STAY_PRESENTATION",public_image_origins:["https://photos.example.test"]},reason:"Explicit owned native Guest Hub public image acceptance"});return updated;});
 await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,property:{id:property.id,name:property.name},reservation:{id:f.reservation.id},grants:f.grants,policy:f.policy}),{flag:"wx"});
}finally{await db.$disconnect();}
