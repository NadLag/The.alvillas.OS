import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {withTenant,type TenantTransactionRunner,type TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import { createConfigRuleVersion } from "@/modules/config/application/config-service";
import { authContextForAccount } from "@/platform/authz/account-context";
import { guestHubHome } from "@/modules/guest-hub/application/guest-hub-home";
import { GuestHubRepository } from "@/modules/guest-hub/infrastructure/guest-hub-repository";
import { guestHubPropertyInformationKey } from "@/platform/config/guest-hub-property-information";
import {reviewGuestHubIssue,issueGuestHubLink,reviewGuestHubRevocation,revokeGuestHubLink} from "@/modules/guest-hub/application/guest-hub-service";
import {visitGuestHubLink} from "@/modules/guest-hub/application/guest-hub-visit";
import {guestHubPresentationPolicyKey} from "@/modules/guest-hub/domain/guest-hub-presentation";
import {GuestHubInvalidLinkError} from "@/modules/guest-hub/domain/guest-hub-policy";
import {nativeGuestHubFixture} from "./support/guest-hub-fixture";
import {nativeLeadFinancialGuard} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

type Fixture=Awaited<ReturnType<typeof nativeGuestHubFixture>>;
let admin:PrismaClient,db:PrismaClient,f:Fixture,other:Fixture,sibling:Fixture,financial:Awaited<ReturnType<typeof nativeLeadFinancialGuard>>,issued:Awaited<ReturnType<typeof issueGuestHubLink>>,queryCount=0;
const organizations:string[]=[],env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"native-guest-home:"+randomBytes(32).toString("base64")},privatePhoto="https://photos.example.test/private.jpg?token=private-owned-photo",publicPhoto="https://photos.example.test/actual-native-villa.webp",deps=()=>({db,env,verificationOrganizationId:f.organizationId,clientKey:"owned-native-guest-home"});
async function presentation(origins:string[],fixture=f,scopeType:"property"|"organization"="property"){return withTenant(db,fixture.organizationId,tx=>new ConfigRuleRepository(tx,fixture.organizationId).createVersion({key:guestHubPresentationPolicyKey,scopeType,scopeId:scopeType==="property"?fixture.property.id:null,createdBy:fixture.account.id,effectiveFrom:new Date("2020-01-01"),value:{source:"NATIVE_GUEST_STAY_PRESENTATION",public_image_origins:origins},reason:"Explicit owned public property image approval"}));}
const visit=()=>visitGuestHubLink({token:issued.token},deps());
beforeAll(async()=>{
 const value=process.env.TEST_DATABASE_URL,url=value?new URL(value):null;if(!url||!["localhost","127.0.0.1"].includes(url.hostname)||!(["/alvillas_automation_guest244_links_20261114","/alvillas_automation_guest246_profile_20261114"].includes(url.pathname)||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated245 Guest Hub home database required");
 admin=new PrismaClient({datasourceUrl:value});expect((await admin.$queryRaw<Array<{count:number}>>`SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].count).toBeGreaterThanOrEqual(url.pathname==="/alvillas_automation_guest246_profile_20261114"?246:245);await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";const counted=new PrismaClient({datasourceUrl:url.toString(),log:[{emit:"event",level:"query"}]});counted.$on("query",()=>{queryCount++;});db=counted;financial=await nativeLeadFinancialGuard(admin,db);f=await nativeGuestHubFixture(admin,db);organizations.push(f.organizationId);other=await nativeGuestHubFixture(admin,db);organizations.push(other.organizationId);sibling=await nativeGuestHubFixture(admin,db,{}, {organizationId:f.organizationId,accountId:f.account.id,personId:f.person.id});
 await withTenant(db,f.organizationId,tx=>tx.property.update({where:{id:f.property.id},data:{photoUrls:[privatePhoto,publicPhoto],name:"Actual native Guest Hub home "+"Long villa name ".repeat(10)}}));const draft={reservationId:f.reservation.id},review=await reviewGuestHubIssue(f.ctx,draft,{db,env});issued=await issueGuestHubLink(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual original native stay home admission"},{db,env});
},120000);
afterAll(async()=>{try{if(financial)await financial.assertPreserved(organizations);}finally{await db?.$disconnect();await admin?.$disconnect();}});
describe("actual scoped multilingual Guest Hub home source",()=>{
 it("projects only the actual stay/property facts and offers a labelled-photo fallback without implicit media approval",async()=>{
  const before=await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}})),view=await visit();expect(view).toMatchObject({id:issued.id,propertyId:f.property.id,home:{photoUrl:null,adultCount:1,childCount:0,calendarStage:"UPCOMING"}});expect(view.home.propertyName).toContain("Actual native Guest Hub home");expect(new Date(view.home.checkedAt).getTime()).toBeLessThanOrEqual(Date.now());for(const key of["guestName","guestEmail","owner","financial","internalAccessNotes","photoUrls"])expect(view.home).not.toHaveProperty(key);expect(JSON.stringify(view).includes(privatePhoto)).toBe(false);expect(await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}}))).toEqual(before);
 });
 it("does not borrow public-image approval from another property or tenant",async()=>{await presentation(["https://photos.example.test"],sibling);await presentation(["https://photos.example.test"],other,"organization");expect((await visit()).home.photoUrl).toBeNull();});
 it("uses the independently approved property origin while withholding private signed media and original bearer material",async()=>{await presentation(["https://photos.example.test"]);const view=await visit();expect(view.home.photoUrl).toBe(publicPhoto);for(const value of[privatePhoto,issued.token!,f.reservation.guestId!])expect(JSON.stringify(view).includes(value)).toBe(false);});
 it("keeps source lookup bounded with500 unrelated properties instead of taking their names or images",async()=>{
  await withTenant(db,f.organizationId,tx=>tx.property.createMany({data:Array.from({length:500},(_,index)=>({organizationId:f.organizationId,name:"Unrelated native home property "+index,addressLine1:"Other private address",city:f.property.city,timezone:f.property.timezone,propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:["https://other.example.test/hidden.jpg"]}))}));const before=queryCount,view=await visit(),queries=queryCount-before;expect(queries).toBeGreaterThan(0);expect(queries).toBeLessThanOrEqual(50);expect(view.propertyId).toBe(f.property.id);expect(view.home.photoUrl).toBe(publicPhoto);expect(view.home.propertyName.startsWith("Actual native Guest Hub home")).toBe(true);expect(JSON.stringify(view).includes("Unrelated native home")).toBe(false);
 });
 it("withdraws image approval immediately without changing or reminting the original capability",async()=>{const before=await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}}));await presentation([]);expect((await visit()).home.photoUrl).toBeNull();expect(await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}}))).toEqual(before);});
 it("closes a real in-flight media-policy withdrawal before returning data or committing an opened audit",async()=>{
  await presentation(["https://photos.example.test"]);const before=await withTenant(db,f.organizationId,tx=>tx.auditLog.count({where:{action:"guest_hub.link_opened",resourceId:issued.id}}));let changed=false;
  const racing=db.$extends({query:{configRule:{async findMany({args,query}){const rows=await query(args);if(args.where?.key===guestHubPresentationPolicyKey&&!changed){changed=true;await presentation([]);}return rows;}}}});
  const checked:TenantTransactionRunner={$transaction:(work,options)=>racing.$transaction(tx=>work(tx as unknown as TenantTransaction),options)};
  await expect(visitGuestHubLink({token:issued.token},{...deps(),db:checked})).rejects.toBeInstanceOf(GuestHubInvalidLinkError);expect(changed).toBe(true);expect(await withTenant(db,f.organizationId,tx=>tx.auditLog.count({where:{action:"guest_hub.link_opened",resourceId:issued.id}}))).toBe(before);expect((await visit()).home.photoUrl).toBeNull();
 });
 it("rejects caller-provided home facts and a foreign path before exposing either property's native metadata",async()=>{await expect(visitGuestHubLink({token:issued.token,home:{propertyName:"Forged property",photoUrl:publicPhoto}},deps())).rejects.toBeInstanceOf(GuestHubInvalidLinkError);await expect(visitGuestHubLink({token:issued.token},{...deps(),expectedLinkId:randomUUID()})).rejects.toBeInstanceOf(GuestHubInvalidLinkError);});
 it("publishes encrypted property-only information and discloses Wi-Fi only during the scheduled stay", async () => {
  const information = { supportPhone: "+212612345678", emergencyPhone: "19",
    wifi: { network: "Isolated acceptance network", password: randomUUID() },
    instructions: { en: "Meet reception", fr: "Rendez-vous à la réception", ar: "توجه إلى الاستقبال" } };
  await withTenant(db, f.organizationId, async tx => {
   const role = await tx.role.create({ data: { organizationId: f.organizationId, key: `guest_information_${randomUUID()}`, name: "Guest property information publisher" } });
   const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, key: { in: ["config_rule:configure", "property:view"] } } });
   expect(permissions).toHaveLength(2);
   await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.organizationId, roleId: role.id, permissionId: permission.id })) });
   await tx.roleAssignment.create({ data: { organizationId: f.organizationId, personId: f.person.id, userAccountId: f.account.id, roleId: role.id, scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
  });
  const actor = { ...f.ctx, authContext: await authContextForAccount(f.organizationId, f.account.id, { db }) };
  const input = { key: guestHubPropertyInformationKey, scopeType: "property" as const, scopeId: f.property.id,
    lifecycle: "ACTIVE" as const, effectiveFrom: new Date("2020-01-01"), valueJson: JSON.stringify(information),
    reason: "Publish original property information for the owned test stay" };
  const action = { db, env, requestId: randomUUID(), ipAddress: null };
  await expect(createConfigRuleVersion(actor, { ...input, scopeId: sibling.property.id }, action)).rejects.toThrow();
  const version = await createConfigRuleVersion(actor, input, action);
  const audit = await withTenant(db, f.organizationId, tx => tx.auditLog.findMany({ where: { resourceId: version.id } }));
  expect(audit).toHaveLength(1);
  expect(JSON.stringify({ version, audit })).not.toContain(information.wifi.password);
  const upcoming = await visit();
  expect(upcoming.home.propertyInformation).toEqual({ supportPhone: information.supportPhone, emergencyPhone: information.emergencyPhone, instructions: information.instructions });
  expect(JSON.stringify(upcoming)).not.toContain(information.wifi.network);
  await withTenant(db, f.organizationId, async tx => {
   const repository = new GuestHubRepository(tx, f.organizationId);
   const source = await repository.source(f.reservation.id);
   if (!source) throw Error("An original Guest Hub stay is required");
   const arrival = await guestHubHome(tx, f.organizationId, source, [], new Date("2031-05-01T15:00:00Z"), env);
   const after = await guestHubHome(tx, f.organizationId, source, [], new Date("2031-05-05T15:00:00Z"), env);
   expect(arrival.data.propertyInformation).toEqual(information);
   expect(after.data.propertyInformation).toBeUndefined();
  });
 });
 it("withholds the entire home after actual final native revocation and retains the original immutable row",async()=>{const before=await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}})),review=await reviewGuestHubRevocation(f.ctx,{linkId:issued.id},{db,env});await revokeGuestHubLink(f.ctx,{linkId:issued.id,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Final owned stay-home revocation"},{db,env});await expect(visit()).rejects.toBeInstanceOf(GuestHubInvalidLinkError);expect(await withTenant(db,f.organizationId,tx=>tx.guestHubLink.findUniqueOrThrow({where:{id:issued.id}}))).toEqual(before);});
});
