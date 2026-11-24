import type {TenantTransaction} from "@/platform/db/tenant";
import {OrganizationRepository} from "@/modules/organization/infrastructure/organization-repository";
export const nativeOrganizationTimezone=(tx:TenantTransaction,organizationId:string)=>new OrganizationRepository(tx,organizationId).operationalTimezone();
