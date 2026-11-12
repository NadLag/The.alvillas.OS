import {writeFile} from "node:fs/promises";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {nativeOnboardingOwnerPackageFixture} from "../../integration/support/onboarding-owner-package-fixture";
import {documentFixtureObjects} from "./document-fixture-objects";

/** Actual native services run in the same supported Node/tsx environment as PostgreSQL acceptance. */
const [organizationId,accountId,origin,output]=z.tuple([z.uuid(),z.uuid(),z.url(),z.string().min(1)]).parse(process.argv.slice(2)),database=new URL(process.env.DATABASE_URL??"invalid:"),server=new URL(origin);
if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(database.hostname)||!["127.0.0.1","localhost"].includes(server.hostname)||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os"))throw Error("Owned native report fixture process required");
const db=new PrismaClient();try{
 const migrations=await db.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name='20261111190000_onboarding_report_document_sources' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;if(migrations[0].count!==1)throw Error("Actual native report migration237 required");
 const f=await nativeOnboardingOwnerPackageFixture(db,db,process.env,{objects:documentFixtureObjects(origin,{write:true})},{organizationId,accountId});
 await writeFile(output,JSON.stringify({organizationId:f.organizationId,review:{id:f.review.id,propertyId:f.review.propertyId},definitions:f.definitions.map(row=>({locale:row.locale,documentId:row.documentId,versionId:row.versionId})),propertyName:f.original.validation.facts.property!.name,agreementReference:f.original.validation.facts.agreement!.reference,agreementId:f.content.agreement_id}),{flag:"wx"});
}finally{await db.$disconnect();}
