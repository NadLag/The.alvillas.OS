import {mkdir,writeFile} from "node:fs/promises";
import {dirname,resolve,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {withTenant} from "@/platform/db/tenant";
import {nativeGroceryExpenseFixture,groceryReceiptTransport} from "../../integration/support/grocery-order-fixture";
const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),target=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned native purchasing browser fixture required");
await mkdir(dirname(resolve(input.output)),{recursive:true,mode:0o700});
const db=new PrismaClient(),transport=await groceryReceiptTransport();try{
 const f=await nativeGroceryExpenseFixture(db,db,transport,input),data=await withTenant(db,f.organizationId,async tx=>{const item=await tx.inventoryItem.create({data:{organizationId:f.organizationId,key:"received.browser."+randomUUID(),category:"LINEN",unit:"piece",labels:{en:"Actual received linen "+randomUUID(),fr:"Linge reçu "+randomUUID(),ar:"كتان مستلم "+randomUUID()}}}),store=await tx.inventoryLocation.create({data:{organizationId:f.organizationId,kind:"STORE",label:"Actual receiving store "+randomUUID()}});return{expenseId:f.expense.id,expensePurpose:f.expense.purpose,itemId:item.id,itemKey:item.key,storeId:store.id,storeLabel:store.label,receiptVersionId:f.originalReceipt.versionId,financialCount:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),postingCount:await tx.posting.count({where:{organizationId:f.organizationId}})};});await writeFile(input.output,JSON.stringify(data),{flag:"wx",mode:0o600});
}finally{await transport.close();await db.$disconnect();}
