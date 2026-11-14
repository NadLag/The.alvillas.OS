import {signBytes,verifyBytes} from "@/platform/auth/secret-encryption";
import {guestHubFormGrantBindingSchema} from "./guest-hub-form-grant-contract";
import {GuestHubProfileConfigurationError} from "./guest-hub-profile-policy";
const grantPurpose="alvillas.guest-hub.form-grant.v1";
export function signGuestHubFormGrant(raw:unknown,env:NodeJS.ProcessEnv=process.env){let plain:Buffer|undefined;try{plain=Buffer.from(JSON.stringify(guestHubFormGrantBindingSchema.parse(raw)));return signBytes(plain,grantPurpose,env);}catch{throw new GuestHubProfileConfigurationError();}finally{plain?.fill(0);}}
export function verifyGuestHubFormGrant(raw:unknown,version:string,signature:Uint8Array,env:NodeJS.ProcessEnv=process.env){let plain:Buffer|undefined;try{plain=Buffer.from(JSON.stringify(guestHubFormGrantBindingSchema.parse(raw)));return verifyBytes(plain,signature,version,grantPurpose,env);}catch{return false;}finally{plain?.fill(0);}}
