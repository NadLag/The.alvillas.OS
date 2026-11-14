import {createHash,randomBytes} from "node:crypto";
import {signBytes,verifyBytes} from "@/platform/auth/secret-encryption";
import {guestHubCapabilityBindingSchema,guestHubCapabilityClaimsSchema,guestHubTokenTextSchema,type GuestHubCapabilityClaims} from "./guest-hub-contract";
import {GuestHubConfigurationError,GuestHubInvalidLinkError,guestHubTokenEntropyBytes} from "./guest-hub-policy";

const purpose="alvillas.guest-hub.capability.v1",prefix="alvillas-guest-v1";
export function decodeGuestHubEnvelopePart(value:string,maximum:number):Buffer{
 if(!/^[A-Za-z0-9_-]+$/u.test(value)||value.length>Math.ceil(maximum*4/3))throw new GuestHubInvalidLinkError();
 const bytes=Buffer.from(value,"base64url");if(bytes.byteLength>maximum||bytes.toString("base64url")!==value){bytes.fill(0);throw new GuestHubInvalidLinkError();}return bytes;
}
export function guestHubCapabilityDigest(token:string):string{return createHash("sha256").update(guestHubTokenTextSchema.parse(token),"utf8").digest("hex");}

/** Only actual server source metadata supplies a binding; original-command recovery never remints it. */
export function issueGuestHubCapability(rawBinding:unknown,env:NodeJS.ProcessEnv=process.env):{token:string;tokenHash:string;claims:GuestHubCapabilityClaims}{
 const binding=guestHubCapabilityBindingSchema.parse(rawBinding),nonce=randomBytes(guestHubTokenEntropyBytes);let plain:Buffer|undefined,signature:Buffer|undefined;
 try{const claims=guestHubCapabilityClaimsSchema.parse({...binding,protocol:"NATIVE_RESERVATION_GUEST_CAPABILITY_V1",nonce:nonce.toString("base64url")});plain=Buffer.from(JSON.stringify(claims),"utf8");const signed=signBytes(plain,purpose,env);signature=signed.signature;const token=guestHubTokenTextSchema.parse([prefix,Buffer.from(signed.version,"utf8").toString("base64url"),plain.toString("base64url"),signature.toString("base64url")].join("."));return{token,tokenHash:guestHubCapabilityDigest(token),claims};}
 catch{throw new GuestHubConfigurationError();}finally{nonce.fill(0);plain?.fill(0);signature?.fill(0);}
}

/** Authenticates bytes only. Native record, revocation, expiry and authorize()/present() gates still precede access. */
export function verifyGuestHubCapability(rawToken:unknown,env:NodeJS.ProcessEnv=process.env):GuestHubCapabilityClaims{
 const allocated:Buffer[]=[],retain=(bytes:Buffer)=>{allocated.push(bytes);return bytes;};
 try{
  const token=guestHubTokenTextSchema.parse(rawToken),[,versionPart,payloadPart,signaturePart]=token.split("."),versionBytes=retain(decodeGuestHubEnvelopePart(versionPart,120)),plain=retain(decodeGuestHubEnvelopePart(payloadPart,2048)),signature=retain(decodeGuestHubEnvelopePart(signaturePart,32));
  const version=new TextDecoder("utf8",{fatal:true}).decode(versionBytes);if(!verifyBytes(plain,signature,version,purpose,env))throw new GuestHubInvalidLinkError();
  const claims=guestHubCapabilityClaimsSchema.parse(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(plain))),nonce=retain(decodeGuestHubEnvelopePart(claims.nonce,guestHubTokenEntropyBytes));if(nonce.byteLength!==guestHubTokenEntropyBytes)throw new GuestHubInvalidLinkError();return claims;
 }catch{throw new GuestHubInvalidLinkError();}finally{for(const bytes of allocated)bytes.fill(0);}
}
