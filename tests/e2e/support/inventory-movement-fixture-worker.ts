import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeGuestHubFixture} from "../../integration/support/guest-hub-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned inventory movement browser fixture required");
const db=new PrismaClient();try{
 const f=await nativeGuestHubFixture(db,db,{},input),result=await withTenant(db,f.organizationId,async tx=>{
  const item=await tx.inventoryItem.create({data:{organizationId:f.organizationId,key:"original.browser.stock."+randomUUID(),category:"LINEN",unit:"piece",labels:{en:"Original browser linen "+randomUUID(),fr:"Linge original du navigateur "+randomUUID(),ar:"كتان أصلي للمتصفح "+randomUUID()}}}),source=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"PROPERTY",propertyId:f.property.id,label:"Actual original source "+randomUUID()}}),destination=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"STORE",label:"Actual original destination "+randomUUID()}});return{itemId:item.id,itemKey:item.key,itemName:item.labels,sourceId:source.id,sourceLabel:source.label,destinationId:destination.id,destinationLabel:destination.label,reservationId:f.reservation.id,reservationReference:f.reservation.reference,financialCount:await tx.financialTransaction.count()};
 });await writeFile(input.output,JSON.stringify(result),{flag:"wx",mode:0o600});
}finally{await db.$disconnect();}
