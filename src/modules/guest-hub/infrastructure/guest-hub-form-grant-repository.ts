import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {guestHubFormKeySchema,type GuestHubFormKey} from "../domain/guest-hub-form-grant-contract";
export class GuestHubFormGrantRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string,private readonly formKey:GuestHubFormKey){}
 grantHead(linkId:string){return this.tx.guestHubFormGrant.findFirst({where:{organizationId:this.organizationId,linkId,formKey:this.formKey},orderBy:{version:"desc"}});}
 async headsForLink(linkId:string){const selected=await this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT DISTINCT ON(form_key) id FROM guest_hub_form_grant WHERE organization_id=${this.organizationId}::uuid AND link_id=${linkId}::uuid AND form_key IN(${Prisma.join(guestHubFormKeySchema.options)}) ORDER BY form_key,version DESC`);return selected.length?this.tx.guestHubFormGrant.findMany({where:{organizationId:this.organizationId,id:{in:selected.map(row=>row.id)}}}):[];}
 // Nonces are unique across forms; callers must reject an original from another form instead of reminting it.
 grantByNonce(commandKey:string){return this.tx.guestHubFormGrant.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 grantById(id:string){return this.tx.guestHubFormGrant.findFirst({where:{organizationId:this.organizationId,id,formKey:this.formKey}});}
 createGrant(input:Omit<Prisma.GuestHubFormGrantUncheckedCreateInput,"organizationId">){if(input.formKey!==this.formKey)throw new Error("guest_form_grant_scope_mismatch");return this.tx.guestHubFormGrant.create({data:{...input,organizationId:this.organizationId}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS guest_form_grant_birth_guard,guest_profile_event_birth_guard IMMEDIATE`);}
}
