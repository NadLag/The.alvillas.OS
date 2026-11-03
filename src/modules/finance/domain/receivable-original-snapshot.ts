import {z} from "zod";

const identity=z.uuid(),money=z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u),posted=z.object({id:identity,ledgerAccountId:identity,side:z.enum(["DEBIT","CREDIT"]),amount:money,currency:z.string().regex(/^[A-Z]{3}$/u)}).passthrough();
export const receivableOriginalSnapshot=z.object({schemaVersion:z.literal(1),posting:posted.extend({organizationId:identity,transactionId:identity}),
  transaction:z.object({id:identity,organizationId:identity,occurredAt:z.iso.datetime({offset:true}),sealed:z.boolean(),reversesTransactionId:identity.nullable(),
    reversedByTransactions:z.array(z.object({id:identity})),postings:z.array(posted)}).passthrough(),
  account:z.object({id:identity,organizationId:identity,code:z.string(),accountType:z.string(),normalSide:z.string()}).passthrough()
}).strict();

