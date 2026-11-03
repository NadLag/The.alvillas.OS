import {z} from "zod";
import {guestDepositReceiptSnapshot} from "./guest-deposit-snapshot";
import {guestDepositApplicationInput} from "./guest-deposit-application-command";
import {receivableAssignmentViewSchema} from "./receivable-assignment";
import {receivableOriginalSnapshot} from "./receivable-original-snapshot";
import {receivablePolicySchema} from "./receivable";
const id=z.uuid().transform(value=>value.toLowerCase());
export const guestDepositApplicationSnapshot=guestDepositReceiptSnapshot.omit({operation:true,input:true}).extend({operation:z.literal("APPLY"),input:guestDepositApplicationInput,originalTransactionId:id,receivableAssignment:receivableAssignmentViewSchema,receivableSource:receivableOriginalSnapshot,receivablePolicy:z.object({id,version:z.number().int().positive(),value:receivablePolicySchema}).strict()}).strict();
