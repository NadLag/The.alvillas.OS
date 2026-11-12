import {createHash} from "node:crypto";

export function recipientKey(organizationId:string,address:string):string{
 return createHash("sha256").update(`${organizationId}:${address.trim().toLowerCase()}`).digest("hex");
}
