import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "./tenant";

/** One PostgreSQL transaction-lock implementation; callers supply their existing explicit namespace. */
export async function advisoryTransactionLock(tx:TenantTransaction,key:string){await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);}
