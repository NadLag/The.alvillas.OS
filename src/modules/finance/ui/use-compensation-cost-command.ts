"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationSubmissionInput,employeeCompensationSubmissionRequestViewSchema } from "../domain/employee-compensation-claim";

type Intent=z.infer<typeof employeeCompensationSubmissionInput>;
type State="checking"|"ready"|"sending"|"pending"|"uncertain"|"offline"|"forbidden"|"recoveryUnavailable"|"terminal";
const recoverySchema=z.object({request:employeeCompensationSubmissionRequestViewSchema.nullable()}).strict();
const readNonce=(key:string)=>{try{const value=z.uuid().safeParse(sessionStorage.getItem(key));return value.success?value.data:null;}catch{return null;}};
const storeNonce=(key:string,value:string)=>{try{sessionStorage.setItem(key,value);}catch{/* An in-memory exact retry remains available. */}};
const removeNonce=(key:string,value:string)=>{try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Storage is optional. */}};

/** Only a scoped random nonce survives a reload. Intent, financial source facts and permissions stay in memory. */
export function useCompensationCostCommand({locale,runId,scope,onInvalidate}:{locale:AppLocale;runId:string;scope:string;onInvalidate:()=>void}){
  const router=useRouter(),storageKey="alvillas.compensation.cost.pending.v1."+scope;
  const [state,setState]=useState<State>("checking"),[error,setError]=useState<string|null>(null),[requestId,setRequestId]=useState<string|null>(null);
  const nonce=useRef<string|null>(null),intent=useRef<Intent|null>(null),busy=useRef(false),generation=useRef(0),alive=useRef(false);
  const invalidateGeneration=useCallback(()=>{generation.current++;},[]);
  const receive=useCallback((value:unknown)=>{
    const receipt=employeeCompensationSubmissionRequestViewSchema.parse(value);if(receipt.runId!==runId)throw Error("Different source acknowledgement");
    if(receipt.state==="SUCCEEDED"&&receipt.submissionId){if(nonce.current)removeNonce(storageKey,nonce.current);intent.current=null;router.replace(`/${locale}/app/finance/compensation/proposals/${receipt.submissionId}`);return;}
    if(receipt.state==="PENDING"){setRequestId(receipt.requestId);setState("pending");setError(null);return;}
    intent.current=null;setRequestId(null);setState("terminal");setError(receipt.failureCode);
  },[locale,router,runId,storageKey]);
  const deny=useCallback(()=>{generation.current++;intent.current=null;setRequestId(null);setState("forbidden");setError("forbidden");onInvalidate();},[onInvalidate]);
  const recover=useCallback(async()=>{
    if(!navigator.onLine){setState("offline");return;}if(!nonce.current){setState("ready");return;}
    const own=++generation.current;setState("checking");setError(null);
    try{
      const response=await fetch("/api/finance/compensation/submission-requests/recover",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId,key:nonce.current})});
      if(!alive.current||own!==generation.current)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Recovery unavailable");
      const result=recoverySchema.parse(await response.json());if(!alive.current||own!==generation.current)return;
      if(result.request)receive(result.request);else{intent.current=null;setRequestId(null);setState("ready");}
    }catch{if(alive.current&&own===generation.current){setState("recoveryUnavailable");setError("recoveryUnavailable");}}
  },[deny,receive,runId]);
  useEffect(()=>{
    alive.current=true;let disposed=false;queueMicrotask(()=>{if(disposed)return;nonce.current=readNonce(storageKey);void recover();});
    const offline=()=>{generation.current++;intent.current=null;setRequestId(null);setState("offline");setError("offline");onInvalidate();},online=()=>{void recover();};
    window.addEventListener("offline",offline);window.addEventListener("online",online);
    return()=>{disposed=true;alive.current=false;invalidateGeneration();window.removeEventListener("offline",offline);window.removeEventListener("online",online);};
  },[invalidateGeneration,onInvalidate,recover,storageKey]);
  useEffect(()=>{
    if(state!=="pending"||!requestId)return;let disposed=false;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{
      const response=await fetch(`/api/finance/compensation/submission-requests/${requestId}`,{credentials:"same-origin",cache:"no-store",signal:abort.signal});
      if(disposed)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Request unavailable");
      const receipt=employeeCompensationSubmissionRequestViewSchema.parse(await response.json());if(disposed)return;if(receipt.requestId!==requestId)throw Error("Different request acknowledgement");receive(receipt);
      if(receipt.state==="PENDING")timer=setTimeout(()=>{void poll();},2000);
    }catch{if(!disposed){setState(navigator.onLine?"recoveryUnavailable":"offline");setError(navigator.onLine?"recoveryUnavailable":"offline");}}};
    timer=setTimeout(()=>{void poll();},1000);return()=>{disposed=true;clearTimeout(timer);abort.abort();};
  },[deny,receive,requestId,state]);
  const send=async(input:Omit<Intent,"idempotencyKey">)=>{
    if(busy.current||!["ready","uncertain"].includes(state)||!navigator.onLine)return;
    nonce.current??=crypto.randomUUID();const parsed=employeeCompensationSubmissionInput.safeParse(intent.current??{...input,idempotencyKey:nonce.current});
    if(!parsed.success){setError("validation");return;}intent.current=parsed.data;storeNonce(storageKey,nonce.current);busy.current=true;const own=++generation.current;setState("sending");setError(null);
    try{
      const response=await fetch("/api/finance/compensation/submissions",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(parsed.data)});
      if(!alive.current||own!==generation.current)return;if(response.status===401||response.status===403){deny();return;}if(!response.ok)throw Error("Submission acknowledgement unavailable");
      const receipt=employeeCompensationSubmissionRequestViewSchema.parse(await response.json());if(!alive.current||own!==generation.current)return;receive(receipt);
    }catch{if(alive.current&&own===generation.current){setState("uncertain");setError("uncertain");}}finally{busy.current=false;}
  };
  const startNew=()=>{if(state!=="terminal")return;if(nonce.current)removeNonce(storageKey,nonce.current);nonce.current=null;intent.current=null;setRequestId(null);setError(null);setState("ready");};
  return{state,error,send,recover,startNew,deny};
}
