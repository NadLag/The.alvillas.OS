"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { SkeletonBlock } from "@/design-system/shells";
import { documentSourceKinds } from "../domain/document-policy";
import { documentUploadReviewInput,documentUploadInput,type documentSourceReferenceSchema } from "../domain/document-command";
import { documentSourceChoicesSchema,documentSourceWorkspaceSchema,documentEffectiveHistorySchema,documentUploadAdmissionSchema,documentUploadRecoverySchema,documentPartReceiptSchema,
  type documentItemSchema,type documentVersionItemSchema } from "../domain/document-read-model";
import { DocumentFileEditor,type DocumentFileDraft } from "./document-file-editor";
import { DocumentHistoryPanel } from "./document-history-panel";
import { DocumentBrowserError,documentRequest,rejectDocumentResponse,readDocumentNonce,writeDocumentNonce,clearDocumentNonce,type DocumentBrowserState } from "./document-browser";
import { documentUploadChunkBytes,documentSingleBodyBytes } from "../domain/document-upload-parts";
import { DocumentTemplateEditor,type AuthoredTemplateDraft } from "./document-template-editor";
import { documentTemplateAdmissionSchema,documentTemplateDraftSchema } from "../domain/document-template-command";
import { encodeDocumentTemplate,decodeDocumentTemplate,type DocumentTemplateDefinition } from "../domain/document-template";
import { documentTemplateMediaType,documentTemplateFileName } from "../domain/document-template-format";
import {DocumentGenerationPanel} from "./document-generation-panel";
import {DocumentSearchPanel} from "./document-search-panel";
import {DocumentRetentionPanel} from "./document-retention-panel";
import {DocumentExpiryPanel} from "./document-expiry-panel";
import {DocumentSignaturePanel} from "./document-signature-panel";
import {documentEffectiveHistoryFormat} from "../domain/document-effective-version";

type Source=z.infer<typeof documentSourceReferenceSchema>;
type Workspace=z.infer<typeof documentSourceWorkspaceSchema>;
type History=z.infer<typeof documentEffectiveHistorySchema>;
type Document=z.infer<typeof documentItemSchema>;
type Version=z.infer<typeof documentVersionItemSchema>;
type Admission=z.infer<typeof documentUploadAdmissionSchema>;
type Command=z.infer<typeof documentUploadInput>;
const reviewSchema=z.object({reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),privacy:z.array(z.string()),number:z.number().int().positive()}).strict();
const templateReviewSchema=reviewSchema.extend({metadata:documentUploadReviewInput});
const digest=async(bytes:Uint8Array<ArrayBuffer>)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");

/** Private document data stays in memory; only the actual account's random command nonce survives a reload. */
export function DocumentArchiveWorkspace({locale,scope,initialReference,initialSource}:{locale:AppLocale;scope:string;initialReference?:{documentId:string;number:number};initialSource?:Source}){
  const signed=useTranslations("SignedArchive"),t=useTranslations("DocumentArchive"),tt=useTranslations("DocumentTemplates"),storageKey="alvillas:document-upload:"+scope;
  const[sources,setSources]=useState<z.infer<typeof documentSourceChoicesSchema>|null>(null),[workspace,setWorkspace]=useState<Workspace|null>(null),[history,setHistory]=useState<History|null>(null),
    [editor,setEditor]=useState<Pick<Workspace,"types"|"policyFingerprint">|null>(null),[source,setSource]=useState<Source|null>(null),[sourceKind,setSourceKind]=useState<Source["kind"]>("PROPERTY"),[query,setQuery]=useState(""),
    [kind,setKind]=useState<"FILE"|"TEMPLATE">("FILE"),[amendment,setAmendment]=useState<{document:Document;version:Version}|null>(null),[signatureVersion,setSignatureVersion]=useState<Version|null>(null),[expiryVersion,setExpiryVersion]=useState<Version|null>(null),[retentionVersion,setRetentionVersion]=useState<Version|null>(null),[receipt,setReceipt]=useState<Admission|null>(null),[resumeFile,setResumeFile]=useState<File|null>(null),
    [state,setState]=useState<DocumentBrowserState>("loading"),[busy,setBusy]=useState(false),[hasPending,setHasPending]=useState(false),[unrecorded,setUnrecorded]=useState(false),[canRetry,setCanRetry]=useState(false),[epoch,setEpoch]=useState(0),[formSerial,setFormSerial]=useState(0),
    [templateMode,setTemplateMode]=useState<"AUTHORED"|"ORIGINAL">("AUTHORED"),[templateDefinition,setTemplateDefinition]=useState<DocumentTemplateDefinition|null>(null);
  const initialHandled=useRef(false),alive=useRef(false),generation=useRef(0),requests=useRef(new Set<AbortController>()),sequences=useRef({sources:0,workspace:0,history:0}),
    nonce=useRef<string|null>(null),intent=useRef<Command|null>(null),originalFile=useRef<File|null>(null),templateIntent=useRef<z.infer<typeof documentTemplateAdmissionSchema>|null>(null),busyRef=useRef(false),operation=useRef(0),denied=useRef(false),
    view=useRef<{source:Source|null;documentId:string|null;kind:"FILE"|"TEMPLATE";sourceKind:Source["kind"];query:string}>({source:null,documentId:null,kind:"FILE",sourceKind:"PROPERTY",query:""});
  const active=useCallback((own:number)=>alive.current&&generation.current===own,[]);
  const wipe=useCallback(()=>{
    generation.current++;operation.current++;busyRef.current=false;for(const controller of requests.current)controller.abort();requests.current.clear();
    intent.current=null;originalFile.current=null;templateIntent.current=null;setTemplateDefinition(null);setTemplateMode("AUTHORED");setCanRetry(false);view.current={source:null,documentId:null,kind:"FILE",sourceKind:"PROPERTY",query:""};
    setSources(null);setWorkspace(null);setHistory(null);setEditor(null);setSource(null);setReceipt(null);setResumeFile(null);setAmendment(null);setSignatureVersion(null);setExpiryVersion(null);setRetentionVersion(null);setQuery("");setSourceKind("PROPERTY");setKind("FILE");setBusy(false);setUnrecorded(false);setHasPending(Boolean(nonce.current));setEpoch(value=>value+1);
  },[]);
  const failed=useCallback((error:unknown)=>{
    const code=!navigator.onLine?"offline":error instanceof DocumentBrowserError?error.state:error instanceof z.ZodError?"validation":"unavailable";
    if(code==="forbidden")denied.current=true;if(code==="forbidden"||code==="offline")wipe();setState(code);
  },[wipe]);
  const controller=useCallback(()=>{const value=new AbortController();requests.current.add(value);return value;},[]);
  const loadSources=useCallback(async(kind:Source["kind"],text:string,cursor?:string)=>{
    const own=generation.current,sequence=++sequences.current.sources,abort=controller();setSources(null);if(!busyRef.current)setState("loading");
    try{const response=await documentRequest(scope,"sources",{kind,query:text,...cursor?{cursor}:{}},abort.signal),data=documentSourceChoicesSchema.parse(await response.json());
      if(active(own)&&sequence===sequences.current.sources){setSources(data);if(!busyRef.current)setState("ready");}}
    catch(error){if(active(own)&&sequence===sequences.current.sources&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);}
  },[active,controller,failed,scope]);
  const loadWorkspace=useCallback(async(reference:Source,mode:"FILE"|"TEMPLATE",cursor?:string)=>{
    const own=generation.current,sequence=++sequences.current.workspace,abort=controller();setWorkspace(null);if(!busyRef.current)setState("loading");
    try{const response=await documentRequest(scope,"read",{source:reference,kind:mode,...cursor?{cursor}:{}},abort.signal),data=documentSourceWorkspaceSchema.parse(await response.json());
      if(active(own)&&sequence===sequences.current.workspace){setWorkspace(data);setEditor({types:data.types,policyFingerprint:data.policyFingerprint});if(!busyRef.current)setState("ready");return data;}}
    catch(error){if(active(own)&&sequence===sequences.current.workspace&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);}
  },[active,controller,failed,scope]);
  const openBookmarkedSource=useCallback(async(reference:Source)=>{
    view.current={source:reference,documentId:null,kind:"FILE",sourceKind:reference.kind,query:""};setSource(reference);setSourceKind(reference.kind);setKind("FILE");setQuery("");await loadWorkspace(reference,"FILE");
  },[loadWorkspace]);
  const loadHistory=useCallback(async(documentId:string,before?:number,publish=true)=>{
    const own=generation.current,sequence=++sequences.current.history,abort=controller();setHistory(null);setSignatureVersion(null);setExpiryVersion(null);setRetentionVersion(null);
    try{const response=await documentRequest(scope,"history",{documentId,format:documentEffectiveHistoryFormat,...before?{before}:{}},abort.signal),data=documentEffectiveHistorySchema.parse(await response.json());
      if(active(own)&&sequence===sequences.current.history){if(publish){view.current.documentId=documentId;setHistory(data);}return data;}}
    catch(error){if(active(own)&&sequence===sequences.current.history&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);}
  },[active,controller,failed,scope]);
  const receive=useCallback(async(value:Admission)=>{
    if(value.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");
    const original=intent.current;
    if(original&&(value.expected.sha256!==original.sha256||value.expected.fileSize!==original.fileSize||value.expected.contentType!==original.contentType||value.expected.fileName!==original.fileName))throw new DocumentBrowserError("unavailable");
    setReceipt(value);setUnrecorded(false);if(value.state==="ADMITTED")setState("ready");
    if(value.expected.contentType===documentTemplateMediaType)setTemplateMode("AUTHORED");
    if(value.state!=="ADMITTED"){clearDocumentNonce(storageKey,value.idempotencyKey);nonce.current=null;intent.current=null;originalFile.current=null;templateIntent.current=null;setTemplateDefinition(null);setCanRetry(false);setHasPending(false);setResumeFile(null);setFormSerial(number=>number+1);setState(value.state==="COMPLETE"?"saved":"conflict");}
    const data=await loadHistory(value.documentId,undefined,false);if(!data)return;
    const mode=data.document.kind==="TEMPLATE"?"TEMPLATE":"FILE";view.current.source=data.document.source;view.current.documentId=data.document.id;view.current.kind=mode;
    if(view.current.sourceKind!==data.document.source.kind){view.current.sourceKind=data.document.source.kind;view.current.query="";setSourceKind(data.document.source.kind);setQuery("");}
    setSource(data.document.source);setKind(mode);setHistory(data);setAmendment(null);
    await loadWorkspace(data.document.source,mode);
  },[loadHistory,loadWorkspace,storageKey]);
  const uploadBytes=useCallback(async(admission:Admission,file:File,bytes?:Uint8Array<ArrayBuffer>)=>{
    if(admission.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");
    const own=generation.current,abort=controller();
    try{const body=bytes??new Uint8Array(await file.arrayBuffer());if(body.length!==admission.expected.fileSize||await digest(body)!==admission.expected.sha256)throw new DocumentBrowserError("validation");
      const parts=admission.expected.parts;
      if(parts){
        for(let index=0;index<parts.hashes.length;index++){
          const chunk=body.subarray(index*parts.chunkBytes,(index+1)*parts.chunkBytes);if(await digest(chunk)!==parts.hashes[index])throw new DocumentBrowserError("validation");
          const response=await fetch("/api/documents/part?admissionId="+encodeURIComponent(admission.id)+"&index="+index,{method:"POST",credentials:"same-origin",cache:"no-store",signal:abort.signal,headers:{"content-type":"application/octet-stream","x-alvillas-document-scope":scope},body:new Uint8Array(chunk)});
          if(!response.ok)await rejectDocumentResponse(response);const value=documentPartReceiptSchema.parse(await response.json());
          if(!active(own))return;if(value.admissionId!==admission.id||value.idempotencyKey!==nonce.current||value.index!==index||value.sha256!==parts.hashes[index])throw new DocumentBrowserError("unavailable");
        }
        const value=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"complete",{admissionId:admission.id},abort.signal)).json());if(active(own))await receive(value);return;
      }
      const response=await fetch("/api/documents/upload?admissionId="+encodeURIComponent(admission.id),{method:"POST",credentials:"same-origin",cache:"no-store",signal:abort.signal,headers:{"content-type":"application/octet-stream","x-alvillas-document-scope":scope},body:new Uint8Array(body)});
      if(!response.ok)await rejectDocumentResponse(response);const value=documentUploadAdmissionSchema.parse(await response.json());if(active(own))await receive(value);
    }finally{requests.current.delete(abort);}
  },[active,controller,receive,scope]);
  const recover=useCallback(async()=>{
    if(!nonce.current||busyRef.current)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("loading");
    try{const key=nonce.current,response=await documentRequest(scope,"recover",{idempotencyKey:key},abort.signal),value=documentUploadRecoverySchema.parse(await response.json());
      if(!active(own))return;if(value.idempotencyKey!==key)throw new DocumentBrowserError("unavailable");
      if(value.recorded)await receive(value);else{setReceipt(null);setUnrecorded(true);setHasPending(true);setState("ready");}}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  },[active,controller,failed,receive,scope]);
  const send=useCallback(async(draft:DocumentFileDraft,file:File)=>{
    if(busyRef.current||!source||!editor)return;const own=generation.current,token=++operation.current;busyRef.current=true;setBusy(true);setState("sending");setHistory(null);
    const abort=controller();
    try{const type=editor.types.find(type=>type.key===draft.typeKey);if(!type||file.size<1||file.size>type.maxBytes||!type.contentTypes.some(type=>type===file.type))throw new DocumentBrowserError("validation");
      const bytes=new Uint8Array(await file.arrayBuffer()),parts=bytes.length>documentSingleBodyBytes?{schemaVersion:1,chunkBytes:documentUploadChunkBytes,
        hashes:await Promise.all(Array.from({length:Math.ceil(bytes.length/documentUploadChunkBytes)},(_,index)=>digest(bytes.subarray(index*documentUploadChunkBytes,(index+1)*documentUploadChunkBytes))))}:undefined;
      const metadata=documentUploadReviewInput.parse({documentId:amendment?.document.id??null,source,typeKey:draft.typeKey,kind:draft.kind,locale:draft.locale,title:draft.title,
        fileName:file.name,contentType:file.type,fileSize:file.size,sha256:await digest(bytes),supersedesId:amendment?.version.id??null,effectiveFrom:draft.effectiveFrom,templateKey:draft.templateKey,...parts?{parts}:{}});
      const review=reviewSchema.parse(await(await documentRequest(scope,"review",metadata,abort.signal)).json());if(!active(own))return;
      nonce.current??=crypto.randomUUID();writeDocumentNonce(storageKey,nonce.current);setHasPending(true);setUnrecorded(false);
      const input=documentUploadInput.parse({...metadata,idempotencyKey:nonce.current,reviewFingerprint:review.reviewFingerprint,reason:draft.reason});intent.current=input;originalFile.current=file;templateIntent.current=null;setCanRetry(true);
      const admission=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"admit",input,abort.signal)).json());if(!active(own))return;
      if(admission.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");setReceipt(admission);
      if(admission.state==="ADMITTED")await uploadBytes(admission,file,bytes);else await receive(admission);
    }catch(error){if(active(own)&&!abort.signal.aborted){if(nonce.current&&!(error instanceof DocumentBrowserError)&&!(error instanceof z.ZodError))setState("uncertain");else failed(error);}}
    finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  },[active,amendment,controller,editor,failed,receive,scope,source,storageKey,uploadBytes]);
  const sendTemplate=async(value:AuthoredTemplateDraft)=>{
    if(busyRef.current||!source||!editor)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("sending");setHistory(null);
    try{
      const draft=documentTemplateDraftSchema.parse({documentId:amendment?.document.id??null,source,typeKey:value.typeKey,title:value.title,supersedesId:amendment?.version.id??null,effectiveFrom:value.effectiveFrom,definition:value.definition}),
        bytes=encodeDocumentTemplate(draft.definition),review=templateReviewSchema.parse(await(await documentRequest(scope,"templates/review",draft,abort.signal)).json()),metadata=review.metadata;
      if(!active(own))return;
      if(metadata.kind!=="TEMPLATE"||metadata.contentType!==documentTemplateMediaType||metadata.documentId!==draft.documentId||metadata.source.kind!==source.kind||metadata.source.id!==source.id||metadata.typeKey!==draft.typeKey||metadata.title!==draft.title||metadata.supersedesId!==draft.supersedesId||metadata.templateKey!==draft.definition.templateKey||metadata.locale!==draft.definition.locale||metadata.fileName!==documentTemplateFileName(draft.definition.templateKey,draft.definition.locale)||metadata.fileSize!==bytes.length||metadata.sha256!==await digest(bytes))throw new DocumentBrowserError("unavailable");
      nonce.current??=crypto.randomUUID();writeDocumentNonce(storageKey,nonce.current);setHasPending(true);setUnrecorded(false);
      const command=documentTemplateAdmissionSchema.parse({...draft,idempotencyKey:nonce.current,reviewFingerprint:review.reviewFingerprint,reason:value.reason});templateIntent.current=command;originalFile.current=null;intent.current=documentUploadInput.parse({...metadata,idempotencyKey:nonce.current,reviewFingerprint:review.reviewFingerprint,reason:value.reason});setCanRetry(true);
      const admitted=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"templates/admit",command,abort.signal)).json());if(!active(own))return;
      if(admitted.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");setReceipt(admitted);
      const result=admitted.state==="ADMITTED"?documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"complete",{admissionId:admitted.id},abort.signal)).json()):admitted;if(active(own))await receive(result);
    }catch(error){if(active(own)&&!abort.signal.aborted){if(nonce.current&&!(error instanceof DocumentBrowserError)&&!(error instanceof z.ZodError))setState("uncertain");else failed(error);}}
    finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const resumeTemplate=async()=>{
    if(busyRef.current||!receipt||receipt.expected.contentType!==documentTemplateMediaType)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("sending");
    try{const result=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"complete",{admissionId:receipt.id},abort.signal)).json());if(active(own))await receive(result);}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const resume=async()=>{
    if(busyRef.current||!receipt||!resumeFile)return;const own=generation.current,token=++operation.current;busyRef.current=true;setBusy(true);setState("sending");
    try{await uploadBytes(receipt,resumeFile);}catch(error){if(active(own))failed(error);}finally{if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const retryExact=async()=>{
    if(busyRef.current||!intent.current||!originalFile.current&&!templateIntent.current)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("sending");
    try{const typed=templateIntent.current,value=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,typed?"templates/admit":"admit",typed??intent.current,abort.signal)).json());if(!active(own))return;if(value.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");if(value.state==="ADMITTED"){if(typed){const result=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"complete",{admissionId:value.id},abort.signal)).json());if(active(own))await receive(result);}else if(originalFile.current)await uploadBytes(value,originalFile.current);}else await receive(value);}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const download=async(version:Version,refresh=true)=>{
    if(busyRef.current)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("loading");setHistory(null);
    try{const response=await documentRequest(scope,"download",{versionId:version.id},abort.signal),blob=await response.blob();if(!active(own))return;
      const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=version.fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
      if(refresh&&view.current.documentId)await loadHistory(view.current.documentId);setState("ready");}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const amend=async(version:Version)=>{
    if(busyRef.current||!history)return;const original=history.document;
    if(original.kind==="INSTANCE"){setAmendment({document:original,version});setTemplateDefinition(null);return;}
    if(version.contentType!==documentTemplateMediaType||original.kind!=="TEMPLATE"){setTemplateDefinition(null);setTemplateMode("ORIGINAL");setAmendment({document:original,version});setFormSerial(value=>value+1);return;}
    const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("loading");setHistory(null);
    try{const response=await documentRequest(scope,"download",{versionId:version.id},abort.signal),bytes=new Uint8Array(await response.arrayBuffer());if(!active(own))return;
      if(bytes.length!==version.fileSize||await digest(bytes)!==version.sha256)throw new DocumentBrowserError("unavailable");const definition=decodeDocumentTemplate(bytes);if(definition.templateKey!==original.templateKey||definition.locale!==original.locale)throw new DocumentBrowserError("conflict");
      if(active(own)){setTemplateDefinition(definition);setTemplateMode("AUTHORED");setAmendment({document:original,version});setFormSerial(value=>value+1);await loadHistory(original.id);setState("ready");}}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const openInitial=useCallback(async(reference:{documentId:string;number:number})=>{
    const own=generation.current,data=await loadHistory(reference.documentId,reference.number+1,false);if(!data||!active(own))return;
    const version=data.versions.find(item=>item.number===reference.number);if(!version){failed(new DocumentBrowserError("unavailable"));return;}
    const mode=data.document.kind==="TEMPLATE"?"TEMPLATE":"FILE";view.current={source:data.document.source,documentId:data.document.id,kind:mode,sourceKind:data.document.source.kind,query:""};setSource(data.document.source);setSourceKind(data.document.source.kind);setQuery("");setKind(mode);setHistory(data);setExpiryVersion(version);await loadWorkspace(data.document.source,mode);
  },[active,failed,loadHistory,loadWorkspace]);
  useEffect(()=>{
    alive.current=true;let disposed=false;const pending=requests.current,invalidate=()=>{generation.current++;};
    queueMicrotask(()=>{if(disposed)return;nonce.current=readDocumentNonce(storageKey);setHasPending(Boolean(nonce.current));if(!navigator.onLine){wipe();setState("offline");return;}if(nonce.current)void recover();else if(initialReference&&!initialHandled.current){initialHandled.current=true;void openInitial(initialReference);}else if(initialSource&&!initialReference)void openBookmarkedSource(initialSource);else setState("ready");});
    const offline=()=>{wipe();setState("offline");},refresh=()=>{
      if(busyRef.current||denied.current||!navigator.onLine||document.visibilityState==="hidden")return;if(nonce.current){void recover();return;}
      const current=view.current;setSources(null);setWorkspace(null);setHistory(null);
      if(current.source){void loadWorkspace(current.source,current.kind);if(current.documentId)void loadHistory(current.documentId);}else if(initialSource&&!initialReference)void openBookmarkedSource(initialSource);else void loadSources(current.sourceKind,current.query);
    },visibility=()=>{if(document.visibilityState==="hidden"){wipe();setState(navigator.onLine?"ready":"offline");}else refresh();};
    window.addEventListener("offline",offline);window.addEventListener("online",refresh);window.addEventListener("focus",refresh);window.addEventListener("pagehide",wipe);document.addEventListener("visibilitychange",visibility);
    return()=>{disposed=true;alive.current=false;invalidate();for(const abort of pending)abort.abort();pending.clear();window.removeEventListener("offline",offline);window.removeEventListener("online",refresh);window.removeEventListener("focus",refresh);window.removeEventListener("pagehide",wipe);document.removeEventListener("visibilitychange",visibility);};
  },[initialReference,initialSource,openInitial,openBookmarkedSource,loadHistory,loadSources,loadWorkspace,recover,storageKey,wipe]);
  const blocked=state==="offline"||state==="forbidden";
  useEffect(()=>{if(blocked||!navigator.onLine||document.visibilityState==="hidden"||hasPending&&!unrecorded)return;const timer=setTimeout(()=>{void loadSources(sourceKind,query);},200);return()=>clearTimeout(timer);},[sourceKind,query,epoch,hasPending,unrecorded,loadSources,blocked]);
  const locked=busy||(hasPending&&!unrecorded),selectSource=(reference:Source)=>{if(locked)return;sequences.current.history++;setHistory(null);setEditor(null);setAmendment(null);setTemplateDefinition(null);setSource(reference);view.current.source=reference;view.current.documentId=null;void loadWorkspace(reference,kind);};
  const openDocument=(item:Document)=>{if(locked)return;const mode=item.kind==="TEMPLATE"?"TEMPLATE":"FILE";setKind(mode);setEditor(null);setAmendment(null);setTemplateDefinition(null);view.current.kind=mode;void loadWorkspace(item.source,mode);void loadHistory(item.id);};
  const authoredTypes=editor?.types.filter(type=>type.contentTypes.includes(documentTemplateMediaType))??[],fileTypes=editor?.types.map(type=>({...type,contentTypes:type.contentTypes.filter(value=>value!==documentTemplateMediaType)})).filter(type=>type.contentTypes.length)??[],
    authoring=kind==="TEMPLATE"&&authoredTypes.length>0&&(templateMode==="AUTHORED"||fileTypes.length===0),canEdit=editor&&(!hasPending||unrecorded)&&amendment?.document.kind!=="INSTANCE",formKey=`${scope}:${epoch}:${formSerial}:${source?.id}:${kind}:${editor?.policyFingerprint}:${amendment?.version.id??"new"}`;
  if(state==="offline"||state==="forbidden")return <section className="resource-form" data-testid="document-private-unavailable"><p role="alert">{t(state)}</p><button className="secondary-button" onClick={()=>window.location.reload()}>{t("reload")}</button></section>;
  return <div className="resource-form" data-testid="document-archive-workspace"><DocumentSearchPanel key={scope+":"+epoch} scope={scope} source={source} disabled={locked} onOpen={reference=>{void openInitial(reference);}} onDownload={version=>{void download(version,false);}} onForbidden={()=>failed(new DocumentBrowserError("forbidden"))}/><section className="resource-form"><h2>{t("status")}</h2><p role="status" data-testid="document-status">{t(busy?"sending":state)}</p>
    {hasPending?<><p>{t(unrecorded?"unrecorded":"pendingGuidance")}</p><div className="form-actions"><button className="secondary-button" disabled={busy} onClick={()=>{void recover();}} data-testid="document-recover">{t("recover")}</button>
      {canRetry&&!unrecorded?<button className="secondary-button" disabled={busy} onClick={()=>{void retryExact();}}>{t("retryExact")}</button>:null}</div></>:null}
    {receipt?.state==="SUPERSEDED"?<p>{t("supersededRequest")}</p>:null}</section>
    {receipt?.state==="ADMITTED"?receipt.expected.contentType===documentTemplateMediaType?<section className="resource-form"><h2>{tt("resumeSaved")}</h2><p>{tt("savedBody")}</p><button className="primary-button" disabled={busy} onClick={()=>{void resumeTemplate();}} data-testid="template-resume">{tt("resumeSaved")}</button></section>:<section className="resource-form"><h2>{t("resumeUpload")}</h2><p dir="auto">{receipt.expected.fileName}</p><p>{t("chooseOriginal")}</p><label className="field"><span>{t("originalFile")}</span><input type="file" accept={receipt.expected.contentType} disabled={busy} onChange={event=>setResumeFile(event.target.files?.[0]??null)} data-testid="document-resume-file"/></label><button className="primary-button" disabled={busy||!resumeFile} onClick={()=>{void resume();}} data-testid="document-resume">{t("resumeUpload")}</button></section>:null}
    <section className="resource-form"><h2>{t("source")}</h2><label className="field"><span>{t("sourceKind")}</span><select value={sourceKind} disabled={locked} onChange={event=>{const value=z.enum(documentSourceKinds).parse(event.target.value);view.current.sourceKind=value;view.current.source=null;view.current.documentId=null;view.current.query="";sequences.current.sources++;sequences.current.workspace++;sequences.current.history++;setSourceKind(value);setQuery("");setSources(null);setSource(null);setWorkspace(null);setEditor(null);setHistory(null);setAmendment(null);setTemplateDefinition(null);}} data-testid="document-source-kind">
      {documentSourceKinds.map(value=><option key={value} value={value}>{t(`source_${value}`)}</option>)}</select></label>
      <label className="field"><span>{t("searchSources")}</span><input value={query} maxLength={120} disabled={locked} onChange={event=>{view.current.query=event.target.value;setQuery(event.target.value);}} dir="auto" data-testid="document-source-query"/></label>
      {!sources?<SkeletonBlock rows={3}/>:<><ul className="resource-list">{sources.items.map(item=><li key={item.source.id}><button className="secondary-button" disabled={locked} aria-pressed={source?.id===item.source.id&&source.kind===item.source.kind} onClick={()=>selectSource(item.source)} data-testid="document-source"><span dir="auto">{item.label}</span></button></li>)}</ul>{!sources.items.length?<p>{t("noSources")}</p>:null}{sources.next?<button className="secondary-button" disabled={locked} onClick={()=>{void loadSources(sourceKind,query,sources.next??undefined);}} data-testid="document-source-more">{t("moreSources")}</button>:null}</>}
    </section>
    {source?<section className="resource-form"><h2 dir="auto">{workspace?.sourceLabel??t("documents")}</h2>{!workspace?<SkeletonBlock rows={3}/>:<><ul className="resource-list">{workspace.items.map(item=><li key={item.id}><button className="secondary-button" disabled={locked} aria-pressed={history?.document.id===item.id} onClick={()=>openDocument(item)} data-testid="document-item"><span dir="auto">{item.title}</span><span>{item.signedArtifact?signed(item.signedArtifact.kind):t(`kind_${item.kind}`)}</span><span>{t(`language_${item.locale}`)}</span>{item.category?<span>{t(`category_${item.category}`)}</span>:null}</button></li>)}</ul>{!workspace.items.length?<p>{t("empty")}</p>:null}{workspace.next?<button className="secondary-button" disabled={locked} onClick={()=>{void loadWorkspace(source,kind,workspace.next??undefined);}} data-testid="document-more">{t("moreDocuments")}</button>:null}</>}
      <label className="field"><span>{t("archiveKind")}</span><select value={kind} disabled={locked} onChange={event=>{const value=z.enum(["FILE","TEMPLATE"]).parse(event.target.value);setKind(value);setAmendment(null);setEditor(null);setTemplateDefinition(null);view.current.kind=value;void loadWorkspace(source,value);}} data-testid="document-kind"><option value="FILE">{t("kind_FILE")}</option><option value="TEMPLATE">{t("kind_TEMPLATE")}</option></select></label>
      {kind==="TEMPLATE"&&authoredTypes.length>0&&canEdit?<label className="field"><span>{tt("mode")}</span><select value={authoring?"AUTHORED":"ORIGINAL"} disabled={busy||!workspace} onChange={event=>setTemplateMode(z.enum(["AUTHORED","ORIGINAL"]).parse(event.target.value))} data-testid="template-mode"><option value="AUTHORED">{tt("authored")}</option>{fileTypes.length?<option value="ORIGINAL">{tt("uploaded")}</option>:null}</select></label>:null}
      {canEdit?authoring?<DocumentTemplateEditor key={formKey+":authored"} locale={locale} types={authoredTypes} identity={amendment?.document.templateKey?{templateKey:amendment.document.templateKey,locale:amendment.document.locale,typeKey:amendment.document.typeKey,title:amendment.version.title}:null} definition={templateDefinition} disabled={busy||!workspace} onSubmit={value=>{void sendTemplate(value);}}/>:fileTypes.length?<DocumentFileEditor key={formKey+":original"} locale={locale} types={fileTypes} kind={kind} amendment={amendment} disabled={busy||!workspace} onSubmit={(draft,file)=>{void send(draft,file);}}/>:<p>{editor?.types.length?tt("templatesOnly"):t("readOnly")}</p>:null}
    </section>:null}
    <DocumentGenerationPanel locale={locale} key={scope+":"+source?.id+":"+epoch+":"+(amendment?.document.kind==="INSTANCE"?amendment.version.id:"new")} scope={scope} source={source} amendment={amendment?.document.kind==="INSTANCE"?amendment:null} onCancel={()=>setAmendment(null)} disabled={locked} onComplete={async documentId=>{const data=await loadHistory(documentId);if(data){view.current.source=data.document.source;view.current.kind="FILE";setSource(data.document.source);setKind("FILE");setAmendment(null);await loadWorkspace(data.document.source,"FILE");}}}/>
    {history?<DocumentHistoryPanel locale={locale} data={history} disabled={locked} canAmend={Boolean(workspace?.types.some(type=>type.key===history.document.typeKey))} onMore={()=>{if(history.next)void loadHistory(history.document.id,history.next);}} onCurrent={()=>{void loadHistory(history.document.id);}} onEffective={()=>{if(history.effectiveVersion)void loadHistory(history.document.id,history.effectiveVersion.number+1);}} onDownload={version=>{void download(version);}} onAmend={version=>{void amend(version);}} onRetention={version=>{setSignatureVersion(null);setExpiryVersion(null);setRetentionVersion(version);}} onExpiry={version=>{setRetentionVersion(null);setSignatureVersion(null);setExpiryVersion(version);}} onSignature={version=>{setExpiryVersion(null);setRetentionVersion(null);setSignatureVersion(version);}} onOriginal={(documentId,number)=>{setSignatureVersion(null);void loadHistory(documentId,number+1);}}/>:null}
    {retentionVersion&&history?.versions.some(version=>version.id===retentionVersion.id)?<DocumentRetentionPanel key={scope+":"+retentionVersion.id+":"+epoch} locale={locale} scope={scope} versionId={retentionVersion.id} disabled={locked} onForbidden={()=>failed(new DocumentBrowserError("forbidden"))}/>:null}
    {expiryVersion&&history?.versions.some(version=>version.id===expiryVersion.id)&&["FILE","INSTANCE"].includes(history.document.kind)&&!history.document.signedArtifact?<DocumentExpiryPanel key={scope+":"+expiryVersion.id+":"+epoch} scope={scope} versionId={expiryVersion.id} disabled={locked} onForbidden={()=>failed(new DocumentBrowserError("forbidden"))}/>:null}
    {signatureVersion&&history?.versions.some(version=>version.id===signatureVersion.id)?<DocumentSignaturePanel key={scope+":"+signatureVersion.id+":"+epoch} scope={scope} version={signatureVersion} sourceKind={history.document.source.kind} disabled={locked} onClose={()=>setSignatureVersion(null)} onForbidden={()=>failed(new DocumentBrowserError("forbidden"))} onOpenArchive={documentId=>{setSignatureVersion(null);void loadHistory(documentId);}}/>:null}
  </div>;
}
