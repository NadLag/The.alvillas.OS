import type { TenantTransaction } from "@/platform/db/tenant";
import { TeamRepository } from "@/modules/identity/infrastructure/team-repository";

// Share Identity's person lock so funding cannot race guarded offboarding.
export async function lockWalletHolders(tx:TenantTransaction,organizationId:string,personIds:string[]){
  const repository=new TeamRepository(tx,organizationId);
  for(const personId of [...new Set(personIds)].sort())await repository.lock(personId);
}

// Finance shares Identity's actual linked-wallet calculation; callers retain their source and wallet checks.
export function readWalletLedger(tx:TenantTransaction,organizationId:string,personId:string){
  return new TeamRepository(tx,organizationId).wallet(personId);
}
