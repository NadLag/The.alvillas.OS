import {writeFile} from "node:fs/promises";
import {resolve,sep} from "node:path";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {nativeGuestHubFixture} from "../../integration/support/guest-hub-fixture";

const input=z.object({organizationId:z.uuid(),accountId:z.uuid(),personId:z.uuid(),guestLocale:z.enum(["en","fr","ar"]),output:z.string().min(1)}).strict().parse(JSON.parse(process.argv[2]??"null")),database=new URL(process.env.DATABASE_URL??"invalid:");
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os")||!resolve(input.output).startsWith(resolve(process.cwd())+sep))throw Error("Owned migrated Guest Hub browser fixture process required");
const db=new PrismaClient();
try{
 const f=await nativeGuestHubFixture(db,db,{},input);
 await writeFile(input.output,JSON.stringify({organizationId:f.organizationId,property:{id:f.property.id},reservation:{id:f.reservation.id},grants:f.grants,policy:f.policy}),{flag:"wx"});
}finally{await db.$disconnect();}
