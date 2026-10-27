import type { TenantTransaction } from "@/platform/db/tenant";
import { TeamRepository } from "@/modules/identity/infrastructure/team-repository";

// Share Identity's person lock so funding cannot race guarded offboarding.
export async function lockWalletHolders(tx:TenantTransaction,organizationId:string,personIds:string[]){
  const repository=new TeamRepository(tx,organizationId);
  for(const personId of [...new Set(personIds)].sort())await repository.lock(personId);
}
