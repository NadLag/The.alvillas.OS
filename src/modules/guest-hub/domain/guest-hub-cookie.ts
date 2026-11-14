import {guestHubIdSchema} from "./guest-hub-contract";
import {GuestHubConfigurationError} from "./guest-hub-policy";

/** A browser-session cookie carries the original capability; the database controls its actual lifetime. */
export function guestHubCapabilityCookie(rawLinkId:unknown,env:NodeJS.ProcessEnv=process.env){
 const id=guestHubIdSchema.parse(rawLinkId);
 try{
  if(!env.APP_URL)throw new GuestHubConfigurationError();const base=new URL(env.APP_URL),secure=base.protocol==="https:",loopback=["localhost","127.0.0.1","[::1]"].includes(base.hostname);
  if(base.username||base.password||base.search||base.hash||!secure&&(!loopback||base.protocol!=="http:"))throw new GuestHubConfigurationError();
  return{name:(secure?"__Secure-":"")+"alvillas_guest_"+id,path:"/api/guest-hub/links/"+id,httpOnly:true as const,secure,sameSite:"strict"as const};
 }catch{throw new GuestHubConfigurationError();}
}
