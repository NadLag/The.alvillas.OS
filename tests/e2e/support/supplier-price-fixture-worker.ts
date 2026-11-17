import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeSupplierPriceFixture} from "../../integration/support/laundry-pricing-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native supplier-price browser fixture required");
const db=new PrismaClient();try{const f=await nativeSupplierPriceFixture(db,db,{...input,propertyName:"Actual original supplier pricing property "+randomUUID()}),financialCount=await withTenant(db,f.organizationId,tx=>tx.financialTransaction.count({where:{organizationId:f.organizationId}}));await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});await writeFile(input.output,JSON.stringify({supplierId:f.supplier.id,supplierLabel:await withTenant(db,f.organizationId,async tx=>(await tx.supplier.findUniqueOrThrow({where:{organizationId_id:{organizationId:f.organizationId,id:f.supplier.id}}})).displayName),itemId:f.item.id,itemKey:f.item.key,propertyId:f.property.id,propertyLabel:f.property.name,financialCount}),{flag:"wx",mode:0o600});}finally{await db.$disconnect();}
