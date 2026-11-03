"use client";
import {useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {SkeletonBlock} from "@/design-system/shells";
import {formatCurrencyAmount,formatDateTime} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {normalizeAmountInput} from "@/platform/money/amount-input";
import {guestDepositCashAdmissionReviewInput} from "../domain/guest-deposit-command";
import {guestDepositCashSourcesSchema,guestDepositCashReviewSchema} from "../domain/guest-deposit-workspace";
import {useCompensationRead} from "./use-compensation-read";
import {companyExpenseFormText as text} from "./company-expense-form-text";
import type {GuestDepositSend} from "./guest-deposit-editor";

type Props={reservationId:string;locale:AppLocale;disabled:boolean;send:GuestDepositSend;onInvalidate:()=>void};
const endpoint="/api/finance/guest-deposits/read";
type Facts=z.infer<typeof guestDepositCashAdmissionReviewInput>;

function CashReview({facts,...props}:Omit<Props,"reservationId">&{facts:Facts}){
 const t=useTranslations("GuestDeposits"),[confirmed,setConfirmed]=useState(false),read=useCompensationRead(endpoint,guestDepositCashReviewSchema,props.onInvalidate,JSON.stringify({operation:"REVIEW_CASH_ADMISSION",...facts}));
 if(read.error)return <p role="alert">{t(read.error)}</p>;
 if(read.pending||!read.data)return <SkeletonBlock rows={3}/>;
 const review=read.data;
 return <section className="resource-form" data-testid="deposit-cash-review"><h3>{t("reviewTitle")}</h3><dl className="compensation-evidence"><div><dt>{t("kind")}</dt><dd>{review.kind.labels[props.locale]}</dd></div><div><dt>{t("amount")}</dt><dd className="compensation-total">{formatCurrencyAmount(props.locale,review.amount.amount,review.amount.currency)}</dd></div><div><dt>{t("cashAvailable")}</dt><dd>{formatCurrencyAmount(props.locale,review.available.amount,review.available.currency)}</dd></div><div><dt>{t("cashCustody")}</dt><dd dir="auto">{review.custody.name}</dd></div><div><dt>{t("receivedAtUtc")}</dt><dd>{formatDateTime(props.locale,new Date(review.receivedAt),{timeZone:"UTC"})}</dd></div></dl><p>{t("cashConfirmation")}</p>
 <form className="resource-form" onSubmit={event=>{event.preventDefault();if(confirmed)props.send({operation:"ADMIT_CASH",input:{...facts,reviewFingerprint:review.reviewFingerprint,reason:text(new FormData(event.currentTarget).get("reason"))}});}}><fieldset className="resource-form" disabled={props.disabled}><legend>{t("confirmation")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="deposit-cash-reason"/></label><label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} data-testid="deposit-cash-confirm"/><span>{t("confirm")}</span></label></fieldset><button className="primary-button" type="submit" disabled={props.disabled||!confirmed} data-testid="deposit-cash-submit">{t("admitCash")}</button></form></section>;
}

export function GuestDepositCashEditor({reservationId,...props}:Props){
 const t=useTranslations("GuestDeposits"),[after,setAfter]=useState<string|undefined>(),[collectionId,setCollectionId]=useState(""),[kind,setKind]=useState(""),[amount,setAmount]=useState(""),[purpose,setPurpose]=useState(""),[facts,setFacts]=useState<Facts|null>(null),[validation,setValidation]=useState(false),read=useCompensationRead(endpoint,guestDepositCashSourcesSchema,props.onInvalidate,JSON.stringify({operation:"CASH_SOURCES",reservationId,after}));
 if(read.error)return <p role="alert">{t(read.error)}</p>;
 if(read.pending||!read.data)return <SkeletonBlock rows={4}/>;
 const options=read.data,selected=options.items.find(row=>row.collectionId===collectionId);
 function resetReview(){setFacts(null);setValidation(false);}
 function page(value:string|undefined){setAfter(value);setCollectionId("");setAmount("");resetReview();}
 return <section className="resource-form" data-testid="deposit-cash-editor"><h3>{t("cashAdmissionTitle")}</h3><p>{t("cashGuidance")}</p>{!options.canAdmit?<p role="status">{t("readOnly")}</p>:null}
 <form className="resource-form" onChange={resetReview} onSubmit={event=>{event.preventDefault();const parsed=guestDepositCashAdmissionReviewInput.safeParse({reservationId,collectionId,kind,amount:normalizeAmountInput(amount),currency:selected?.amount.currency,purpose:purpose.trim()});if(parsed.success)setFacts(parsed.data);else setValidation(true);}}><fieldset className="resource-form" disabled={props.disabled||!options.canAdmit}><legend>{t("movementDetails")}</legend>
 <label className="field"><span>{t("cashCollection")}</span><select required value={collectionId} onChange={event=>{setCollectionId(event.target.value);setAmount("");}} data-testid="deposit-cash-source"><option value="">{t("choose")}</option>{options.items.map(row=><option key={row.collectionId} value={row.collectionId}>{formatDateTime(props.locale,new Date(row.receivedAt),{timeZone:"UTC"})} · {formatCurrencyAmount(props.locale,row.available.amount,row.available.currency)} · {row.purpose}</option>)}</select></label>{!options.items.length?<p>{t("noCashSources")}</p>:null}
 <div className="form-actions">{after?<button className="secondary-button" type="button" onClick={()=>page(undefined)}>{t("first")}</button>:null}{options.next?<button className="secondary-button" type="button" onClick={()=>page(options.next!)}>{t("next")}</button>:null}</div>
 <label className="field"><span>{t("kind")}</span><select required value={kind} onChange={event=>setKind(event.target.value)} data-testid="deposit-cash-kind"><option value="">{t("choose")}</option>{options.kinds.map(row=><option key={row.key} value={row.key}>{row.labels[props.locale]}</option>)}</select></label><label className="field"><span>{t("amount")}</span><input inputMode="decimal" autoComplete="off" required value={amount} onChange={event=>setAmount(event.target.value)} data-testid="deposit-cash-amount"/></label>{selected?<p>{t("cashAvailable")}: {formatCurrencyAmount(props.locale,selected.available.amount,selected.available.currency)}</p>:null}<label className="field"><span>{t("purpose")}</span><textarea dir="auto" required minLength={3} maxLength={1000} value={purpose} onChange={event=>setPurpose(event.target.value)} data-testid="deposit-cash-purpose"/></label><button className="secondary-button" type="submit" data-testid="deposit-cash-prepare">{t("review")}</button></fieldset></form>
 {validation?<p role="alert">{t("validation")}</p>:null}{facts?<CashReview {...props} key={JSON.stringify(facts)} facts={facts}/>:null}</section>;
}
