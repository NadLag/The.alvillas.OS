"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { SkeletonBlock } from "@/design-system/shells";
import { documentSourceKinds } from "../domain/document-policy";
import { documentUploadReviewInput,documentUploadInput,type documentSourceReferenceSchema } from "../domain/document-command";
import { documentSourceChoicesSchema,documentSourceWorkspaceSchema,documentHistorySchema,documentUploadAdmissionSchema,documentUploadRecoverySchema,documentPartReceiptSchema,
  type documentItemSchema,type documentVersionItemSchema } from "../domain/document-read-model";
import { DocumentFileEditor,type DocumentFileDraft } from "./document-file-editor";
import { DocumentHistoryPanel } from "./document-history-panel";
import { DocumentBrowserError,documentRequest,rejectDocumentResponse,readDocumentNonce,writeDocumentNonce,clearDocumentNonce,type DocumentBrowserState } from "./document-browser";
import { documentUploadChunkBytes,documentSingleBodyBytes } from "../domain/document-upload-parts";

type Source=z.infer<typeof documentSourceReferenceSchema>;
type Workspace=z.infer<typeof documentSourceWorkspaceSchema>;
type History=z.infer<typeof documentHistorySchema>;
type Document=z.infer<typeof documentItemSchema>;
type Version=z.infer<typeof documentVersionItemSchema>;
type Admission=z.infer<typeof documentUploadAdmissionSchema>;
type Command=z.infer<typeof documentUploadInput>;
const reviewSchema=z.object({reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),privacy:z.array(z.string()),number:z.number().int().positive()}).strict();
const digest=async(bytes:Uint8Array<ArrayBuffer>)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(value=>value.toString(16).padStart(2,"0")).join("");

/** Private document data stays in memory; only the actual account's random command nonce survives a reload. */
export function DocumentArchiveWorkspace({locale,scope}:{locale:AppLocale;scope:string}){
  const t=useTranslations("DocumentArchive"),storageKey="alvillas:document-upload:"+scope;
  const[sources,setSources]=useState<z.infer<typeof documentSourceChoicesSchema>|null>(null),[workspace,setWorkspace]=useState<Workspace|null>(null),[history,setHistory]=useState<History|null>(null),
    [editor,setEditor]=useState<Pick<Workspace,"types"|"policyFingerprint">|null>(null),[source,setSource]=useState<Source|null>(null),[sourceKind,setSourceKind]=useState<Source["kind"]>("PROPERTY"),[query,setQuery]=useState(""),
    [kind,setKind]=useState<"FILE"|"TEMPLATE">("FILE"),[amendment,setAmendment]=useState<{document:Document;version:Version}|null>(null),[receipt,setReceipt]=useState<Admission|null>(null),[resumeFile,setResumeFile]=useState<File|null>(null),
    [state,setState]=useState<DocumentBrowserState>("loading"),[busy,setBusy]=useState(false),[hasPending,setHasPending]=useState(false),[unrecorded,setUnrecorded]=useState(false),[canRetry,setCanRetry]=useState(false),[epoch,setEpoch]=useState(0),[formSerial,setFormSerial]=useState(0);
  const alive=useRef(false),generation=useRef(0),requests=useRef(new Set<AbortController>()),sequences=useRef({sources:0,workspace:0,history:0}),
    nonce=useRef<string|null>(null),intent=useRef<Command|null>(null),originalFile=useRef<File|null>(null),busyRef=useRef(false),operation=useRef(0),denied=useRef(false),
    view=useRef<{source:Source|null;documentId:string|null;kind:"FILE"|"TEMPLATE";sourceKind:Source["kind"];query:string}>({source:null,documentId:null,kind:"FILE",sourceKind:"PROPERTY",query:""});
  const active=useCallback((own:number)=>alive.current&&generation.current===own,[]);
  const wipe=useCallback(()=>{
    generation.current++;operation.current++;busyRef.current=false;for(const controller of requests.current)controller.abort();requests.current.clear();
    intent.current=null;originalFile.current=null;setCanRetry(false);view.current={source:null,documentId:null,kind:"FILE",sourceKind:"PROPERTY",query:""};
    setSources(null);setWorkspace(null);setHistory(null);setEditor(null);setSource(null);setReceipt(null);setResumeFile(null);setAmendment(null);setQuery("");setSourceKind("PROPERTY");setKind("FILE");setBusy(false);setUnrecorded(false);setHasPending(Boolean(nonce.current));setEpoch(value=>value+1);
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
  const loadHistory=useCallback(async(documentId:string,before?:number,publish=true)=>{
    const own=generation.current,sequence=++sequences.current.history,abort=controller();setHistory(null);
    try{const response=await documentRequest(scope,"history",{documentId,...before?{before}:{}},abort.signal),data=documentHistorySchema.parse(await response.json());
      if(active(own)&&sequence===sequences.current.history){if(publish){view.current.documentId=documentId;setHistory(data);}return data;}}
    catch(error){if(active(own)&&sequence===sequences.current.history&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);}
  },[active,controller,failed,scope]);
  const receive=useCallback(async(value:Admission)=>{
    if(value.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");
    const original=intent.current;
    if(original&&(value.expected.sha256!==original.sha256||value.expected.fileSize!==original.fileSize||value.expected.contentType!==original.contentType||value.expected.fileName!==original.fileName))throw new DocumentBrowserError("unavailable");
    setReceipt(value);setUnrecorded(false);if(value.state==="ADMITTED")setState("ready");
    if(value.state!=="ADMITTED"){clearDocumentNonce(storageKey,value.idempotencyKey);nonce.current=null;intent.current=null;originalFile.current=null;setCanRetry(false);setHasPending(false);setResumeFile(null);setFormSerial(number=>number+1);setState(value.state==="COMPLETE"?"saved":"conflict");}
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
        fileName:file.name,contentType:file.type,fileSize:file.size,sha256:await digest(bytes),supersedesId:amendment?.version.id??null,effectiveFrom:null,templateKey:draft.templateKey,...parts?{parts}:{}});
      const review=reviewSchema.parse(await(await documentRequest(scope,"review",metadata,abort.signal)).json());if(!active(own))return;
      nonce.current??=crypto.randomUUID();writeDocumentNonce(storageKey,nonce.current);setHasPending(true);setUnrecorded(false);
      const input=documentUploadInput.parse({...metadata,idempotencyKey:nonce.current,reviewFingerprint:review.reviewFingerprint,reason:draft.reason});intent.current=input;originalFile.current=file;setCanRetry(true);
      const admission=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"admit",input,abort.signal)).json());if(!active(own))return;
      if(admission.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");setReceipt(admission);
      if(admission.state==="ADMITTED")await uploadBytes(admission,file,bytes);else await receive(admission);
    }catch(error){if(active(own)&&!abort.signal.aborted){if(nonce.current&&!(error instanceof DocumentBrowserError)&&!(error instanceof z.ZodError))setState("uncertain");else failed(error);}}
    finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  },[active,amendment,controller,editor,failed,receive,scope,source,storageKey,uploadBytes]);
  const resume=async()=>{
    if(busyRef.current||!receipt||!resumeFile)return;const own=generation.current,token=++operation.current;busyRef.current=true;setBusy(true);setState("sending");
    try{await uploadBytes(receipt,resumeFile);}catch(error){if(active(own))failed(error);}finally{if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const retryExact=async()=>{
    if(busyRef.current||!intent.current||!originalFile.current)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("sending");
    try{const value=documentUploadAdmissionSchema.parse(await(await documentRequest(scope,"admit",intent.current,abort.signal)).json());if(!active(own))return;if(value.idempotencyKey!==nonce.current)throw new DocumentBrowserError("unavailable");if(value.state==="ADMITTED")await uploadBytes(value,originalFile.current);else await receive(value);}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  const download=async(version:Version)=>{
    if(busyRef.current)return;const own=generation.current,token=++operation.current,abort=controller();busyRef.current=true;setBusy(true);setState("loading");setHistory(null);
    try{const response=await documentRequest(scope,"download",{versionId:version.id},abort.signal),blob=await response.blob();if(!active(own))return;
      const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=version.fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
      if(view.current.documentId)await loadHistory(view.current.documentId);setState("ready");}
    catch(error){if(active(own)&&!abort.signal.aborted)failed(error);}finally{requests.current.delete(abort);if(operation.current===token){busyRef.current=false;setBusy(false);}}
  };
  useEffect(()=>{
    alive.current=true;let disposed=false;const pending=requests.current,invalidate=()=>{generation.current++;};
    queueMicrotask(()=>{if(disposed)return;nonce.current=readDocumentNonce(storageKey);setHasPending(Boolean(nonce.current));if(!navigator.onLine){wipe();setState("offline");return;}if(nonce.current)void recover();else setState("ready");});
    const offline=()=>{wipe();setState("offline");},refresh=()=>{
      if(busyRef.current||denied.current||!navigator.onLine||document.visibilityState==="hidden")return;if(nonce.current){void recover();return;}
      const current=view.current;setSources(null);setWorkspace(null);setHistory(null);
      if(current.source){void loadWorkspace(current.source,current.kind);if(current.documentId)void loadHistory(current.documentId);}else void loadSources(current.sourceKind,current.query);
    },visibility=()=>{if(document.visibilityState==="hidden"){wipe();setState(navigator.onLine?"ready":"offline");}else refresh();};
    window.addEventListener("offline",offline);window.addEventListener("online",refresh);window.addEventListener("focus",refresh);window.addEventListener("pagehide",wipe);document.addEventListener("visibilitychange",visibility);
    return()=>{disposed=true;alive.current=false;invalidate();for(const abort of pending)abort.abort();pending.clear();window.removeEventListener("offline",offline);window.removeEventListener("online",refresh);window.removeEventListener("focus",refresh);window.removeEventListener("pagehide",wipe);document.removeEventListener("visibilitychange",visibility);};
  },[loadHistory,loadSources,loadWorkspace,recover,storageKey,wipe]);
  const blocked=state==="offline"||state==="forbidden";
  useEffect(()=>{if(blocked||!navigator.onLine||document.visibilityState==="hidden"||hasPending&&!unrecorded)return;const timer=setTimeout(()=>{void loadSources(sourceKind,query);},200);return()=>clearTimeout(timer);},[sourceKind,query,epoch,hasPending,unrecorded,loadSources,blocked]);
  const locked=busy||(hasPending&&!unrecorded),selectSource=(reference:Source)=>{if(locked)return;sequences.current.history++;setHistory(null);setEditor(null);setAmendment(null);setSource(reference);view.current.source=reference;view.current.documentId=null;void loadWorkspace(reference,kind);};
  const openDocument=(item:Document)=>{if(locked)return;const mode=item.kind==="TEMPLATE"?"TEMPLATE":"FILE";setKind(mode);setEditor(null);setAmendment(null);view.current.kind=mode;void loadWorkspace(item.source,mode);void loadHistory(item.id);};
  if(state==="offline"||state==="forbidden")return <section className="resource-form" data-testid="document-private-unavailable"><p role="alert">{t(state)}</p><button className="secondary-button" onClick={()=>window.location.reload()}>{t("reload")}</button></section>;
  return <div className="resource-form" data-testid="document-archive-workspace"><section className="resource-form"><h2>{t("status")}</h2><p role="status" data-testid="document-status">{t(busy?"sending":state)}</p>
    {hasPending?<><p>{t(unrecorded?"unrecorded":"pendingGuidance")}</p><div className="form-actions"><button className="secondary-button" disabled={busy} onClick={()=>{void recover();}} data-testid="document-recover">{t("recover")}</button>
      {canRetry&&!unrecorded?<button className="secondary-button" disabled={busy} onClick={()=>{void retryExact();}}>{t("retryExact")}</button>:null}</div></>:null}
    {receipt?.state==="SUPERSEDED"?<p>{t("supersededRequest")}</p>:null}</section>
    {receipt?.state==="ADMITTED"?<section className="resource-form"><h2>{t("resumeUpload")}</h2><p dir="auto">{receipt.expected.fileName}</p><p>{t("chooseOriginal")}</p><label className="field"><span>{t("originalFile")}</span><input type="file" accept={receipt.expected.contentType} disabled={busy} onChange={event=>setResumeFile(event.target.files?.[0]??null)} data-testid="document-resume-file"/></label><button className="primary-button" disabled={busy||!resumeFile} onClick={()=>{void resume();}} data-testid="document-resume">{t("resumeUpload")}</button></section>:null}
    <section className="resource-form"><h2>{t("source")}</h2><label className="field"><span>{t("sourceKind")}</span><select value={sourceKind} disabled={locked} onChange={event=>{const value=z.enum(documentSourceKinds).parse(event.target.value);view.current.sourceKind=value;view.current.source=null;view.current.documentId=null;view.current.query="";sequences.current.sources++;sequences.current.workspace++;sequences.current.history++;setSourceKind(value);setQuery("");setSources(null);setSource(null);setWorkspace(null);setEditor(null);setHistory(null);setAmendment(null);}} data-testid="document-source-kind">
      {documentSourceKinds.map(value=><option key={value} value={value}>{t(`source_${value}`)}</option>)}</select></label>
      <label className="field"><span>{t("searchSources")}</span><input value={query} maxLength={120} disabled={locked} onChange={event=>{view.current.query=event.target.value;setQuery(event.target.value);}} dir="auto" data-testid="document-source-query"/></label>
      {!sources?<SkeletonBlock rows={3}/>:<><ul className="resource-list">{sources.items.map(item=><li key={item.source.id}><button className="secondary-button" disabled={locked} aria-pressed={source?.id===item.source.id&&source.kind===item.source.kind} onClick={()=>selectSource(item.source)} data-testid="document-source"><span dir="auto">{item.label}</span></button></li>)}</ul>{!sources.items.length?<p>{t("noSources")}</p>:null}{sources.next?<button className="secondary-button" disabled={locked} onClick={()=>{void loadSources(sourceKind,query,sources.next??undefined);}} data-testid="document-source-more">{t("moreSources")}</button>:null}</>}
    </section>
    {source?<section className="resource-form"><h2 dir="auto">{workspace?.sourceLabel??t("documents")}</h2>{!workspace?<SkeletonBlock rows={3}/>:<><ul className="resource-list">{workspace.items.map(item=><li key={item.id}><button className="secondary-button" disabled={locked} aria-pressed={history?.document.id===item.id} onClick={()=>openDocument(item)} data-testid="document-item"><span dir="auto">{item.title}</span><span>{t(`kind_${item.kind}`)}</span></button></li>)}</ul>{!workspace.items.length?<p>{t("empty")}</p>:null}{workspace.next?<button className="secondary-button" disabled={locked} onClick={()=>{void loadWorkspace(source,kind,workspace.next??undefined);}} data-testid="document-more">{t("moreDocuments")}</button>:null}</>}
      <label className="field"><span>{t("archiveKind")}</span><select value={kind} disabled={locked} onChange={event=>{const value=z.enum(["FILE","TEMPLATE"]).parse(event.target.value);setKind(value);setAmendment(null);setEditor(null);view.current.kind=value;void loadWorkspace(source,value);}} data-testid="document-kind"><option value="FILE">{t("kind_FILE")}</option><option value="TEMPLATE">{t("kind_TEMPLATE")}</option></select></label>
      {editor&&!hasPending?<DocumentFileEditor key={`${scope}:${epoch}:${formSerial}:${source.id}:${kind}:${editor.policyFingerprint}:${amendment?.version.id??"new"}`} locale={locale} types={editor.types} kind={kind} amendment={amendment} disabled={busy||!workspace} onSubmit={(draft,file)=>{void send(draft,file);}}/>:editor&&unrecorded?<DocumentFileEditor key={`${scope}:${epoch}:${formSerial}:${source.id}:${kind}:${editor.policyFingerprint}`} locale={locale} types={editor.types} kind={kind} amendment={amendment} disabled={busy||!workspace} onSubmit={(draft,file)=>{void send(draft,file);}}/>:null}
    </section>:null}
    {history?<DocumentHistoryPanel locale={locale} data={history} disabled={locked} canAmend={Boolean(workspace?.types.some(type=>type.key===history.document.typeKey))} onMore={()=>{if(history.next)void loadHistory(history.document.id,history.next);}} onCurrent={()=>{void loadHistory(history.document.id);}} onDownload={version=>{void download(version);}} onAmend={version=>{setAmendment({document:history.document,version});setFormSerial(value=>value+1);}}/>:null}
  </div>;
}
