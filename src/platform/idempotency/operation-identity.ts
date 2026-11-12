import {createHash} from "node:crypto";

/** Preserve the canonical automation command identity across every retry. */
export function operationIdentity(key:string){
 const h=createHash("sha256").update(key).digest("hex");
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
