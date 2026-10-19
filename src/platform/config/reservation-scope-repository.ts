import type { TenantTransaction } from "@/platform/db/tenant";
import type { ConfigScopeCandidate } from "./config-rule-repository";

export class ReservationConfigScopeRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  async propertyScopes(propertyIds:string[],asOf:Date){
    const [properties,agreements]=await Promise.all([
      this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:propertyIds}},select:{id:true,cityId:true}}),
      this.tx.managementAgreement.findMany({where:{organizationId:this.organizationId,propertyId:{in:propertyIds},archivedAt:null,status:{not:'DRAFT'},effectiveFrom:{lte:asOf},OR:[{effectiveTo:null},{effectiveTo:{gt:asOf}}]},orderBy:[{effectiveFrom:'desc'},{id:'desc'}],select:{id:true,propertyId:true}})
    ]);
    return new Map(properties.map(p=>[p.id,[{scopeType:'organization',scopeId:null},...(p.cityId?[{scopeType:'city',scopeId:p.cityId}]:[]),{scopeType:'property',scopeId:p.id},...agreements.filter(a=>a.propertyId===p.id).slice(0,1).map(a=>({scopeType:'agreement',scopeId:a.id}))]]));
  }
  async scopes(input: { propertyId: string; ownerId?: string; source?: string; asOf: Date }): Promise<ConfigScopeCandidate[]> {
    const [property, agreement, channel] = await Promise.all([
      this.tx.property.findFirst({ where: { organizationId: this.organizationId, id: input.propertyId }, select: { cityId: true } }),
      this.tx.managementAgreement.findFirst({ where: { organizationId: this.organizationId, propertyId: input.propertyId, archivedAt: null, status: { not: "DRAFT" }, effectiveFrom: { lte: input.asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.asOf } }] }, orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }], select: { id: true } }),
      input.source ? this.tx.bookingChannel.findFirst({ where: { organizationId: this.organizationId, propertyId: input.propertyId, sourceKey: input.source, archivedAt: null }, select: { id: true } }) : null
    ]);
    return [
      { scopeType: "organization", scopeId: null },
      ...(property?.cityId ? [{ scopeType: "city", scopeId: property.cityId }] : []),
      ...(input.ownerId ? [{ scopeType: "owner", scopeId: input.ownerId }] : []),
      { scopeType: "property", scopeId: input.propertyId },
      ...(agreement ? [{ scopeType: "agreement", scopeId: agreement.id }] : []),
      ...(channel ? [{ scopeType: "booking_source_property", scopeId: channel.id }] : [])
    ];
  }
}
