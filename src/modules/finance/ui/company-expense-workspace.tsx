"use client";
import {companyExpenseFormText} from "./company-expense-form-text";
import {useCallback,useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {SkeletonBlock} from "@/design-system/shells";
import {formatCurrencyAmount,formatDate,formatDateTime} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {companyExpenseCommandSchema,companyExpenseCommandResultSchema,type CompanyExpenseCommand} from "../domain/company-expense-command";
import {companyExpenseWorkspaceSettingsSchema,companyExpenseListSchema,companyExpenseDetailSchema,type CompanyExpenseWorkspaceSettings,type CompanyExpensePlanView} from "../domain/company-expense-workspace";
import {useCompensationRead} from "./use-compensation-read";
import {useCompensationCommand} from "./use-compensation-command";
import {CompanyExpenseEditor,CompanyExpenseCancellation,type CompanyExpenseSend} from "./company-expense-editor";
import {CompanyExpenseSources} from "./company-expense-sources";
import {CompanyExpenseSettingsPanel} from "./company-expense-settings";

const endpoint="/api/finance/company-expenses/read",recover=(key:string)=>({key});
const accept=(receipt:z.infer<typeof companyExpenseCommandResultSchema>,input:CompanyExpenseCommand|null,nonce:string|null)=>receipt.idempotencyKey===nonce&&(!input||receipt.operation===input.operation);
function PlanFacts({current,locale}:{current:CompanyExpensePlanView;locale:AppLocale}){
 const t=useTranslations("CompanyExpenses");return <><h3 dir="auto">{current.purpose}</h3><p>{t("estimate",{amount:formatCurrencyAmount(locale,current.amount,current.currency)})}</p><dl><dt>{t("state")}</dt><dd>{t(current.state)}</dd><dt>{t("category")}</dt><dd>{current.categoryLabels[locale]}</dd><dt>{t("costCenter")}</dt><dd>{current.costCenterLabels[locale]}</dd><dt>{t("dueOn",{timezone:current.timezone})}</dt><dd>{formatDate(locale,new Date(current.dueOn+"T00:00:00Z"),{timeZone:"UTC"})}</dd><dt>{t("revision")}</dt><dd>{current.version}</dd><dt>{t("reason")}</dt><dd dir="auto">{current.reason}</dd></dl></>;
}
function Detail({id,settings,locale,revision,disabled,send,onInvalidate}:{id:string;settings:CompanyExpenseWorkspaceSettings;locale:AppLocale;revision:number;disabled:boolean;send:CompanyExpenseSend;onInvalidate:()=>void}){
 const t=useTranslations("CompanyExpenses"),[beforeVersion,setBeforeVersion]=useState<number|undefined>(),read=useCompensationRead(endpoint,companyExpenseDetailSchema,onInvalidate,JSON.stringify({operation:"DETAIL",id,beforeVersion}),revision);
 if(read.error)return <p role="alert">{t(read.error==="forbidden"?"forbidden":read.error==="offline"?"offline":"unavailable")}</p>;if(read.pending||!read.data)return <SkeletonBlock rows={4}/>;
 const{current,history,next}=read.data;
 return <section className="resource-form" data-testid="company-plan-detail"><PlanFacts current={current} locale={locale}/>
 {current.state==="PLANNED"&&settings.capabilities.edit?<CompanyExpenseEditor key={current.revisionId} settings={settings} current={current} locale={locale} disabled={disabled} send={send}/>:null}
 {current.state==="PLANNED"&&settings.capabilities.void?<CompanyExpenseCancellation key={current.revisionId+"-cancel"} current={current} disabled={disabled} send={send}/>:null}
 <section data-testid="company-plan-history"><h3>{t("history")}</h3><ol>{history.map(row=><li key={row.revisionId}><p>{t("historyEntry",{version:row.version,amount:formatCurrencyAmount(locale,row.amount,row.currency),state:t(row.state),at:formatDateTime(locale,new Date(row.at),{timeZone:row.timezone})})}</p><p dir="auto">{row.purpose}</p><p dir="auto">{row.reason}</p></li>)}</ol><div className="form-actions">{beforeVersion?<button className="secondary-button" type="button" onClick={()=>setBeforeVersion(undefined)}>{t("first")}</button>:null}{next?<button className="secondary-button" type="button" onClick={()=>setBeforeVersion(next)}>{t("next")}</button>:null}</div></section>
 {settings.capabilities.invoice?<CompanyExpenseSources current={current} kind="INVOICE" locale={locale} canEdit={settings.capabilities.edit} disabled={disabled} send={send} onInvalidate={onInvalidate} revision={revision}/>:null}
 {settings.capabilities.employee&&current.dataClass==="STAFF_COMPENSATION"?<CompanyExpenseSources current={current} kind="EMPLOYEE" locale={locale} canEdit={settings.capabilities.edit} disabled={disabled} send={send} onInvalidate={onInvalidate} revision={revision}/>:null}
 </section>;
}
function Board({settings,scope,locale,onInvalidate,onSettingsChanged,selected,setSelected,creating,setCreating}:{settings:CompanyExpenseWorkspaceSettings;scope:string;locale:AppLocale;onInvalidate:()=>void;onSettingsChanged:()=>void;selected:string|null;setSelected:(id:string|null)=>void;creating:boolean;setCreating:(value:boolean)=>void}){
 const t=useTranslations("CompanyExpenses"),[after,setAfter]=useState<string|undefined>(),[query,setQuery]=useState(""),[state,setState]=useState<"PLANNED"|"CANCELLED"|undefined>(),[revision,setRevision]=useState(0);
 const onSuccess=useCallback((receipt:z.infer<typeof companyExpenseCommandResultSchema>)=>{if(receipt.state==="SUCCEEDED"){setCreating(false);setSelected(receipt.companyExpenseId);setRevision(value=>value+1);}},[setCreating,setSelected]);
 const command=useCompensationCommand({storageKey:`alvillas:company-expense:${scope}`,inputSchema:companyExpenseCommandSchema,receiptSchema:companyExpenseCommandResultSchema,requestPath:"/api/finance/company-expenses/command",recoveryPath:"/api/finance/company-expenses/recover",recoveryInput:recover,accept,onSuccess,onInvalidate});
 const read=useCompensationRead(endpoint,companyExpenseListSchema,onInvalidate,JSON.stringify({operation:"LIST",after,query,state}),revision),disabled=command.state!=="ready",send:CompanyExpenseSend=intent=>{void command.send(intent);};
 return <div className="resource-form">
 <section className="resource-form" data-testid="company-command-status"><p role="status" data-testid="company-command-status-text">{t(`command_${command.state}`)}</p>{command.error==="validation"?<p role="alert">{t("validation")}</p>:null}{["uncertain","recoveryUnavailable","offline"].includes(command.state)?<button type="button" className="secondary-button" onClick={()=>{void command.recover();}}>{t("recover")}</button>:null}{command.state==="uncertain"?<button type="button" className="secondary-button" onClick={()=>{void command.send();}}>{t("retryExact")}</button>:null}{["succeeded","terminal"].includes(command.state)?<button type="button" className="secondary-button" data-testid="company-command-next" onClick={()=>{command.startNew();setRevision(value=>value+1);}}>{t("nextAction")}</button>:null}</section>
 <section className="resource-form"><h2>{t("plans")}</h2><p>{t("estimateGuidance")}</p><form className="resource-form" onSubmit={event=>{event.preventDefault();const form=new FormData(event.currentTarget);setAfter(undefined);setQuery(companyExpenseFormText(form.get("query")));setState(form.get("state")==="PLANNED"?"PLANNED":form.get("state")==="CANCELLED"?"CANCELLED":undefined);}}><div className="form-grid two"><label className="field"><span>{t("searchPlans")}</span><input name="query" maxLength={120} dir="auto"/></label><label className="field"><span>{t("state")}</span><select name="state" defaultValue=""><option value="">{t("allStates")}</option><option value="PLANNED">{t("PLANNED")}</option><option value="CANCELLED">{t("CANCELLED")}</option></select></label></div><button className="secondary-button" type="submit">{t("search")}</button></form>
 {read.error?<p role="alert">{t(read.error==="forbidden"?"forbidden":read.error==="offline"?"offline":"unavailable")}</p>:read.pending?<SkeletonBlock rows={3}/>:<><ul data-testid="company-plan-list">{read.data?.items.map(row=><li key={row.id}><button type="button" className="secondary-button" data-testid="company-plan-open" onClick={()=>{setCreating(false);setSelected(row.id);}}><span dir="auto">{row.purpose}</span> · {formatCurrencyAmount(locale,row.amount,row.currency)} · {t(row.state)}</button></li>)}</ul>{!read.data?.items.length?<p>{t("noPlans")}</p>:null}<div className="form-actions">{after?<button className="secondary-button" type="button" onClick={()=>setAfter(undefined)}>{t("first")}</button>:null}{read.data?.next?<button className="secondary-button" type="button" onClick={()=>setAfter(read.data!.next!)}>{t("next")}</button>:null}</div></>}
 {settings.capabilities.create?<button className="primary-button" type="button" data-testid="company-new" disabled={disabled||!settings.categories.length||!settings.costCenters.length||!settings.timezone} onClick={()=>{setSelected(null);setCreating(true);}}>{t("create")}</button>:null}{!settings.categories.length||!settings.costCenters.length||!settings.timezone?<p>{t("configurationRequired")}</p>:null}</section>
 {creating?<CompanyExpenseEditor settings={settings} current={null} locale={locale} disabled={disabled} send={send}/>:selected?<Detail key={selected} id={selected} settings={settings} locale={locale} revision={revision} disabled={disabled} send={send} onInvalidate={onInvalidate}/>:null}
 {settings.capabilities.configure?<CompanyExpenseSettingsPanel settings={settings} locale={locale} onInvalidate={onInvalidate} onChanged={onSettingsChanged}/>:null}
 </div>;
}
export function CompanyExpenseWorkspace({scope,locale}:{scope:string;locale:AppLocale}){
 const t=useTranslations("CompanyExpenses"),[blocked,setBlocked]=useState(false),[selected,setSelected]=useState<string|null>(null),[creating,setCreating]=useState(false),invalidate=useCallback(()=>{setBlocked(true);setSelected(null);setCreating(false);},[setBlocked,setSelected,setCreating]),read=useCompensationRead(endpoint,companyExpenseWorkspaceSettingsSchema,invalidate,JSON.stringify({operation:"SETTINGS"}));
 const clearRead=read.clear,clear=useCallback(()=>clearRead("forbidden"),[clearRead]);
 if(blocked||read.error)return <section><p role="alert">{t(read.error==="offline"?"offline":read.error==="forbidden"||blocked?"forbidden":"unavailable")}</p><button type="button" className="secondary-button" onClick={()=>{setBlocked(false);void read.refresh();}}>{t("refresh")}</button></section>;
 if(read.pending||!read.data)return <SkeletonBlock rows={4}/>;
 return <Board settings={read.data} scope={scope} locale={locale} onInvalidate={clear} onSettingsChanged={()=>{void read.refresh();}} selected={selected} setSelected={setSelected} creating={creating} setCreating={setCreating}/>;
}
