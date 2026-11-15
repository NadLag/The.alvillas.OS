import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {nativeServiceOrderFixture} from "../../integration/support/service-order-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native order browser fixture process required");
const db=new PrismaClient();try{const f=await nativeServiceOrderFixture(db,db,input);await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,property:{id:f.property.id,name:f.property.name},reservationId:f.reservation.id,request:f.request,grants:f.grants,supplierLabel:f.supplierName}),{flag:"wx",mode:0o600});}finally{await db.$disconnect();}
