import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {nativeServiceOrderFinancialFixture} from "../../integration/support/service-order-financial-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),kind:z.enum(["SUPPLIER","EMPLOYEE"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native order financial browser fixture required");
const db=new PrismaClient();try{const f=await nativeServiceOrderFinancialFixture(db,db,input.kind,input);await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,propertyId:f.property.id,orderId:f.orderId,taskId:f.taskId,costId:f.provider.costId,sourceKind:f.provider.command.sourceKind,roleId:f.role.id}),{flag:"wx",mode:0o600});}finally{await db.$disconnect();}
