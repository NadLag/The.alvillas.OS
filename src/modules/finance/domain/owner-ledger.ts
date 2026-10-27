import { z } from "zod";
export { canViewCompleteOwnerLedger } from "@/platform/authz/financial-resource";

const id=z.uuid().transform(value=>value.toLowerCase());
const date=z.iso.date();
export const ownerLedgerFilters=z.object({ownerId:id,propertyId:id.optional(),fromOn:date.optional(),toOn:date.optional(),
  currency:z.string().regex(/^[A-Z]{3}$/u).optional(),timezone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true}catch{return false}}).optional(),after:id.optional()}).strict()
  .refine(value=>!value.fromOn||!value.toOn||value.fromOn<=value.toOn,{path:["toOn"],message:"End must follow start"});
export const ownerLedgerChoiceFilters=z.object({query:z.string().trim().max(120).optional(),after:id.optional()}).strict();
export {ownerStatementBuckets as ownerLedgerBuckets} from "@/platform/ledger/owner-statement";
export function ownerLedgerPath(locale:string,ownerId:string,propertyId?:string){return propertyId?`/${locale}/app/finance/owner-ledgers/properties/${propertyId}/owners/${ownerId}`:`/${locale}/app/finance/owner-ledgers/owners/${ownerId}`}
