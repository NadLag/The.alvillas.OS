import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {nativeServiceCatalogFixture} from "../../integration/support/service-catalog-fixture";

const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),database=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned migrated catalog browser fixture process required");
const db=new PrismaClient();
try{
 const f=await nativeServiceCatalogFixture(db,db,input),original=servicePricingSchema.parse(f.policies.original.value);
 await withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"services.pricing",scopeType:"property",scopeId:f.property.id,createdBy:input.accountId,effectiveFrom:new Date("2020-01-01"),reason:"Actual retained property catalog population for keyset browser acceptance",value:{...original,services:[...original.services,...Array.from({length:21},(_,i)=>({key:"retained_"+String(i).padStart(2,"0"),name:{en:"Retained catalog service "+i,fr:"Service conservé "+i,ar:"خدمة محفوظة "+i},pricing_model:"CUSTOM",available:false}))]}}));
 await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,property:{id:f.property.id,name:f.property.name},supplier:{id:f.supplier.id,label:f.supplierName},grants:f.grants,allocationRuleId:f.policies.allocation.id,taxRuleId:f.policies.tax.id}),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
