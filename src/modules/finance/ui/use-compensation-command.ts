"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { z } from "zod";
type Receipt={requestId:string;state:"PENDING"|"SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";failureCode:string|null};
type State="checking"|"ready"|"sending"|"pending"|"uncertain"|"offline"|"forbidden"|"recoveryUnavailable"|"terminal"|"succeeded";
type Options<I extends {idempotencyKey:string},R extends Receipt>={storageKey:string;inputSchema:z.ZodType<I>;receiptSchema:z.ZodType<R>;requestPath:string;recoveryPath:string;statusPath:(id:string)=>string;recoveryInput:(key:string)=>unknown;accept:(receipt:R)=>boolean;onSuccess:(receipt:R)=>void;onInvalidate:()=>void};
const readNonce=(key:string)=>{try{const value=z.uuid().safeParse(sessionStorage.getItem(key));return value.success?value.data:null;}catch{return null;}};
const storeNonce=(key:string,value:string)=>{try{sessionStorage.setItem(key,value);}catch{/* Exact retries remain available in memory. */}};
const removeNonce=(key:string,value:string)=>{try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Storage is optional. */}};
/** Only a scoped random nonce survives reloads. Financial intent and authority stay in memory. */
export function useCompensationCommand<I extends {idempotencyKey:string},R extends Receipt>({storageKey,inputSchema,receiptSchema,requestPath,recoveryPath,statusPath,recoveryInput,accept,onSuccess,onInvalidate}:Options<I,R>){
  const [state,setState]=useState<State>("checking"),[error,setError]=useState<string|null>(null),[requestId,setRequestId]=useState<string|null>(null);
  const nonce=useRef<string|null>(null),intent=useRef<I|null>(null),busy=useRef(false),generation=useRef(0),alive=useRef(false);
  const invalidateGeneration=useCallback(()=>{generation.current++;},[]);
  const receive=useCallback((value:unknown)=>{
    const receipt=receiptSchema.parse(value);if(!accept(receipt)||receipt.state==="PENDING"&&receipt.failureCode!==null||receipt.state!=="PENDING"&&receipt.state!=="SUCCEEDED"&&!receipt.failureCode)throw Error("Invalid source acknowledgement");
    if(receipt.state==="SUCCEEDED"){if(nonce.current)removeNonce(storageKey,nonce.current);intent.current=null;setRequestId(null);setState("succeeded");setError(null);onSuccess(receipt);return;}
    if(receipt.state==="PENDING"){setRequestId(receipt.requestId);setState("pending");setError(null);return;}
    intent.current=null;setRequestId(null);setState("terminal");setError(receipt.failureCode);
  },[accept,onSuccess,receiptSchema,storageKey]);
  const deny=useCallback(()=>{generation.current++;intent.current=null;setRequestId(null);setState("forbidden");setError("forbidden");onInvalidate();},[onInvalidate]);
  const recover=useCallback(async()=>{
    if(!navigator.onLine){setState("offline");return;}if(!nonce.current){setState("ready");return;}
    const own=++generation.current;setState("checking");setError(null);
    try{
      const response=await fetch(recoveryPath,{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(recoveryInput(nonce.current))});
      if(!alive.current||own!==generation.current)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Recovery unavailable");
      const result=z.object({request:receiptSchema.nullable()}).strict().parse(await response.json());if(!alive.current||own!==generation.current)return;
      if(result.request)receive(result.request);else{intent.current=null;setRequestId(null);setState("ready");}
    }catch{if(alive.current&&own===generation.current){setState("recoveryUnavailable");setError("recoveryUnavailable");}}
  },[deny,receiptSchema,receive,recoveryInput,recoveryPath]);
  useEffect(()=>{
    alive.current=true;let disposed=false;queueMicrotask(()=>{if(disposed)return;nonce.current=readNonce(storageKey);void recover();});
    const offline=()=>{generation.current++;intent.current=null;setRequestId(null);setState("offline");setError("offline");onInvalidate();},online=()=>{void recover();};
    window.addEventListener("offline",offline);window.addEventListener("online",online);
    return()=>{disposed=true;alive.current=false;invalidateGeneration();window.removeEventListener("offline",offline);window.removeEventListener("online",online);};
  },[invalidateGeneration,onInvalidate,recover,storageKey]);
  useEffect(()=>{
    if(state!=="pending"||!requestId)return;let disposed=false;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{
      const response=await fetch(statusPath(requestId),{credentials:"same-origin",cache:"no-store",signal:abort.signal});
      if(disposed)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Request unavailable");
      const receipt=receiptSchema.parse(await response.json());if(disposed)return;if(receipt.requestId!==requestId)throw Error("Different request acknowledgement");receive(receipt);
      if(receipt.state==="PENDING")timer=setTimeout(()=>{void poll();},2000);
    }catch{if(!disposed){setState(navigator.onLine?"recoveryUnavailable":"offline");setError(navigator.onLine?"recoveryUnavailable":"offline");}}};
    timer=setTimeout(()=>{void poll();},1000);return()=>{disposed=true;clearTimeout(timer);abort.abort();};
  },[deny,receiptSchema,receive,requestId,state,statusPath]);
  const send=async(input:Omit<I,"idempotencyKey">)=>{
    if(busy.current||!["ready","uncertain"].includes(state)||!navigator.onLine)return;
    nonce.current??=crypto.randomUUID();const parsed=inputSchema.safeParse(intent.current??{...input,idempotencyKey:nonce.current});
    if(!parsed.success){setError("validation");return;}intent.current=parsed.data;storeNonce(storageKey,nonce.current);busy.current=true;const own=++generation.current;setState("sending");setError(null);
    try{
      const response=await fetch(requestPath,{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(parsed.data)});
      if(!alive.current||own!==generation.current)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Command acknowledgement unavailable");
      const receipt=receiptSchema.parse(await response.json());if(!alive.current||own!==generation.current)return;receive(receipt);
    }catch{if(alive.current&&own===generation.current){setState("uncertain");setError("uncertain");}}finally{busy.current=false;}
  };
  const startNew=()=>{if(state!=="terminal")return;if(nonce.current)removeNonce(storageKey,nonce.current);nonce.current=null;intent.current=null;setRequestId(null);setError(null);setState("ready");};
  const track=useCallback((receipt:R)=>{if(!busy.current&&!intent.current&&(state==="ready"||state==="succeeded"))receive(receipt);},[receive,state]);
  return{state,error,send,recover,startNew,deny,track};
}
