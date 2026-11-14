import {z} from "zod";
import {signBytes,verifyBytes} from "@/platform/auth/secret-encryption";
import {guestHubIdSchema,guestHubFingerprintSchema} from "./guest-hub-contract";
import {decodeGuestHubEnvelopePart} from "./guest-hub-capability";
import {GuestHubConflictError,GuestHubConfigurationError} from "./guest-hub-policy";

const purpose="alvillas.guest-hub.directory.v1",prefix="guest-directory-v1";
const schema=z.object({protocol:z.literal("NATIVE_GUEST_LINK_DIRECTORY_V1"),organizationId:guestHubIdSchema,actorId:guestHubIdSchema,reservationId:guestHubIdSchema,cap:guestHubFingerprintSchema,source:guestHubFingerprintSchema,policy:guestHubFingerprintSchema.nullable(),asOf:z.iso.datetime(),beforeId:guestHubIdSchema,beforeAt:z.iso.datetime()}).strict();
export type GuestHubDirectoryCursor=z.infer<typeof schema>;
export type GuestHubDirectoryBinding=Pick<GuestHubDirectoryCursor,"organizationId"|"actorId"|"reservationId"|"cap"|"source"|"policy">;
export function signGuestHubDirectoryCursor(raw:GuestHubDirectoryCursor,env:NodeJS.ProcessEnv=process.env):string{
 let plain:Buffer|undefined,signature:Buffer|undefined;
 try{const value=schema.parse(raw);plain=Buffer.from(JSON.stringify(value),"utf8");const signed=signBytes(plain,purpose,env);signature=signed.signature;return[prefix,Buffer.from(signed.version,"utf8").toString("base64url"),plain.toString("base64url"),signature.toString("base64url")].join(".");}
 catch{throw new GuestHubConfigurationError();}finally{plain?.fill(0);signature?.fill(0);}
}
export function readGuestHubDirectoryCursor(raw:string,binding:GuestHubDirectoryBinding,now:Date,env:NodeJS.ProcessEnv=process.env):GuestHubDirectoryCursor{
 const allocated:Buffer[]=[],retain=(bytes:Buffer)=>{allocated.push(bytes);return bytes;};
 try{
  if(raw.length>6000||!/^guest-directory-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(raw))throw new GuestHubConflictError();
  const[,versionPart,payloadPart,signaturePart]=raw.split("."),version=retain(decodeGuestHubEnvelopePart(versionPart,120)),plain=retain(decodeGuestHubEnvelopePart(payloadPart,2048)),signature=retain(decodeGuestHubEnvelopePart(signaturePart,32));
  if(!verifyBytes(plain,signature,new TextDecoder("utf8",{fatal:true}).decode(version),purpose,env))throw new GuestHubConflictError();
  const cursor=schema.parse(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(plain)));for(const key of["organizationId","actorId","reservationId","cap","source","policy"]as const)if(cursor[key]!==binding[key])throw new GuestHubConflictError();
  if(!Number.isFinite(now.getTime())||Date.parse(cursor.asOf)>now.getTime()||Date.parse(cursor.beforeAt)>Date.parse(cursor.asOf))throw new GuestHubConflictError();return cursor;
 }catch{throw new GuestHubConflictError();}finally{for(const bytes of allocated)bytes.fill(0);}
}
