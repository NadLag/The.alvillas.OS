import { createHash } from "node:crypto";
export function commandFingerprint(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
/** Persisted JSONB may reorder object keys. Preserve arrays and scalar values while authenticating its complete contents. */
export function jsonbFingerprint(value:unknown){
 function ordered(item:unknown):unknown{if(Array.isArray(item))return item.map(ordered);if(item!==null&&typeof item==="object")return Object.fromEntries(Object.entries(item as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,ordered(child)]));return item;}
 return commandFingerprint(ordered(value));
}
