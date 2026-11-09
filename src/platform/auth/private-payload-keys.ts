/** Existing private-record key validation, shared without changing the retained key-ring contract. */
export function requirePrivatePayloadKeys(env:NodeJS.ProcessEnv,encrypting:boolean,denied:()=>Error){
 const entries=env.ENCRYPTION_KEYS?.split(",").map(entry=>entry.trim()).filter(Boolean)??[],versions=new Set<string>();
 if(!entries.length)throw denied();
 for(const[index,entry]of entries.entries()){
  const boundary=entry.indexOf(":"),version=boundary<0?"v1":entry.slice(0,boundary),material=boundary<0?entry:entry.slice(boundary+1);
  if(!version||!material||versions.has(version))throw denied();
  if(encrypting&&index===0){
   if(!/^[a-zA-Z0-9_.-]{1,120}$/u.test(version)||!/^[a-zA-Z0-9+/]+={0,2}$/u.test(material))throw denied();
   const decoded=Buffer.from(material,"base64");
   try{if(decoded.length!==32||decoded.toString("base64")!==material)throw denied();}finally{decoded.fill(0);}
  }
  versions.add(version);
 }
}
