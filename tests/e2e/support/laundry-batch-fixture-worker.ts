import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeLaundryBatchFixture,nativeLaundryStock} from "../../integration/support/laundry-batch-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native laundry browser fixture required");
const db=new PrismaClient();try{const f=await nativeLaundryBatchFixture(db,db,input);await nativeLaundryStock(f,{kind:"PURCHASE",itemId:f.item.id,locationId:f.home.id,quantity:"20",reason:"Actual original linen stock for the real batch browser journey"});const financialCount=await withTenant(db,f.organizationId,tx=>tx.financialTransaction.count({where:{organizationId:f.organizationId}}));await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});await writeFile(input.output,JSON.stringify({itemId:f.item.id,itemKey:f.item.key,homeId:f.home.id,homeLabel:f.home.label,outboundLabel:f.outbound.label,laundryLabel:f.laundry.label,inboundLabel:f.inbound.label,financialCount}),{flag:"wx",mode:0o600});}finally{await db.$disconnect();}
