"use client";
import {useState} from "react";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import {SkeletonBlock} from "@/design-system/shells";
import {formatCurrencyAmount} from "@/i18n/format";
import type {AppLocale} from "@/i18n/routing";
import {normalizeAmountInput} from "@/platform/money/amount-input";
import {guestDepositFundedApplicationReviewInput} from "../domain/guest-deposit-command";
import {guestDepositApplicationReviewSchema} from "../domain/guest-deposit-workspace";
import {useCompensationRead} from "./use-compensation-read";
import type {GuestDepositSend} from "./guest-deposit-editor";
import {companyExpenseFormText as text} from "./company-expense-form-text";

type Props={depositId:string;limit:{amount:string;currency:string};locale:AppLocale;disabled:boolean;send:GuestDepositSend;onInvalidate:()=>void};
type Facts=z.infer<typeof guestDepositFundedApplicationReviewInput>;
function Review({facts,...props}:Props&{facts:Facts}){
 const t=useTranslations("GuestDeposits"),[confirmed,setConfirmed]=useState(false),read=useCompensationRead("/api/finance/guest-deposits/read",guestDepositApplicationReviewSchema,props.onInvalidate,JSON.stringify({operation:"REVIEW_APPLICATION",...facts}));
 if(read.error)return <p role="alert">{t(read.error)}</p>;if(read.pending||!read.data)return <SkeletonBlock rows={3}/>;const review=read.data,money=(value:{amount:string;currency:string})=>formatCurrencyAmount(props.locale,value.amount,value.currency);
 return <section className="resource-form" data-testid="deposit-application-review"><h3>{t("reviewTitle")}</h3><dl className="compensation-evidence"><div><dt>{t("amount")}</dt><dd className="compensation-total">{money(review.amount)}</dd></div><div><dt>{t("quotedAccommodation")}</dt><dd>{money(review.quote)}</dd></div><div><dt>{t("alreadyApplied")}</dt><dd>{money(review.applied)}</dd></div><div><dt>{t("commissionChange")}</dt><dd>{money(review.commissionDelta)}</dd></div><div><dt>{t("outstanding")}</dt><dd>{money(review.outstanding)}</dd></div></dl><p>{t("applicationConfirmation")}</p>
 <form className="resource-form" onSubmit={event=>{event.preventDefault();if(confirmed)props.send({operation:"APPLY",input:{...facts,reviewFingerprint:review.reviewFingerprint,reason:text(new FormData(event.currentTarget).get("reason"))}});}}><fieldset className="resource-form" disabled={props.disabled}><legend>{t("confirmation")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" required minLength={6} maxLength={500} data-testid="deposit-application-reason"/></label><label className="compensation-cost-check"><input type="checkbox" required checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} data-testid="deposit-application-confirm"/><span>{t("confirm")}</span></label></fieldset><button className="primary-button" type="submit" disabled={props.disabled||!confirmed} data-testid="deposit-application-submit">{t("recordApplication")}</button></form></section>;
}

export function GuestDepositApplicationEditor(props:Props){
 const t=useTranslations("GuestDeposits"),[amount,setAmount]=useState(""),[facts,setFacts]=useState<Facts|null>(null),[validation,setValidation]=useState(false);
 return <section className="resource-form" data-testid="deposit-application-editor"><h3>{t("applicationTitle")}</h3><p>{t("applicationGuidance")}</p><p>{t("applicationLimit")}: {formatCurrencyAmount(props.locale,props.limit.amount,props.limit.currency)}</p>
 <form className="resource-form" onSubmit={event=>{event.preventDefault();const parsed=guestDepositFundedApplicationReviewInput.safeParse({depositId:props.depositId,amount:normalizeAmountInput(amount),currency:props.limit.currency});setValidation(!parsed.success);if(parsed.success)setFacts(parsed.data);}}><fieldset className="resource-form" disabled={props.disabled}><legend>{t("movementDetails")}</legend><label className="field"><span>{t("amount")}</span><input name="amount" inputMode="decimal" autoComplete="off" required value={amount} onChange={event=>{setAmount(event.target.value);setFacts(null);setValidation(false);}} data-testid="deposit-application-amount"/></label><p>{t("currency")}: <span dir="ltr">{props.limit.currency}</span></p></fieldset>{validation?<p role="alert">{t("validation")}</p>:null}<button className="secondary-button" type="submit" disabled={props.disabled} data-testid="deposit-application-review-open">{t("review")}</button></form>
 {facts?<Review key={JSON.stringify(facts)} {...props} facts={facts}/>:null}</section>;
}
