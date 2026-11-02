"use client";
import {normalizeAmountInput} from "@/platform/money/amount-input";
import {companyExpenseFormText} from "./company-expense-form-text";
import type {FormEvent} from "react";
import {useTranslations} from "next-intl";
import type {AppLocale} from "@/i18n/routing";
import type {CompanyExpenseCommand} from "../domain/company-expense-command";
import type {CompanyExpensePlanView,CompanyExpenseWorkspaceSettings} from "../domain/company-expense-workspace";

export type CompanyExpenseIntent=CompanyExpenseCommand extends infer C?C extends CompanyExpenseCommand?Omit<C,"idempotencyKey">:never:never;
export type CompanyExpenseSend=(intent:CompanyExpenseIntent)=>void;
export function CompanyExpenseEditor({settings,current,locale,disabled,send}:{settings:CompanyExpenseWorkspaceSettings;current:CompanyExpensePlanView|null;locale:AppLocale;disabled:boolean;send:CompanyExpenseSend}){
 const t=useTranslations("CompanyExpenses");
 function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget),input={amount:normalizeAmountInput(companyExpenseFormText(form.get("amount"))),currency:companyExpenseFormText(form.get("currency")),category:companyExpenseFormText(form.get("category")),costCenter:companyExpenseFormText(form.get("costCenter")),purpose:companyExpenseFormText(form.get("purpose")),dueOn:companyExpenseFormText(form.get("dueOn")),reason:companyExpenseFormText(form.get("reason"))};
  send(current?{operation:"REVISE",input:{...input,id:current.id,expectedVersion:current.version}}:{operation:"CREATE",input});
 }
 return <form className="resource-form" onSubmit={save} data-testid="company-plan-form"><fieldset className="resource-form" disabled={disabled}><legend>{t(current?"revise":"create")}</legend><p>{t("estimateGuidance")}</p><div className="form-grid two">
  <label className="field"><span>{t("amount")}</span><input name="amount" data-testid="company-amount" type="text" inputMode="decimal" dir="ltr" maxLength={19} defaultValue={current?.amount} required/></label>
  <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="company-currency" defaultValue={current?.currency??""} required><option value="" disabled>{t("choose")}</option>{settings.currencies.filter(row=>row.minorUnit<=2).map(row=><option value={row.code} key={row.code}>{row.code}</option>)}</select></label>
  <label className="field"><span>{t("category")}</span><select name="category" data-testid="company-category" defaultValue={current?.category??""} required><option value="" disabled>{t("choose")}</option>{settings.categories.map(row=><option value={row.key} key={row.key}>{row.labels[locale]}</option>)}</select></label>
  <label className="field"><span>{t("costCenter")}</span><select name="costCenter" data-testid="company-cost-center" defaultValue={current?.costCenter??""} required><option value="" disabled>{t("choose")}</option>{settings.costCenters.map(row=><option value={row.key} key={row.key}>{row.labels[locale]}</option>)}</select></label>
  <label className="field"><span>{t("dueOn",{timezone:settings.timezone??""})}</span><input name="dueOn" data-testid="company-due" type="date" defaultValue={current?.dueOn??settings.today??""} required/></label>
 </div><label className="field"><span>{t("purpose")}</span><textarea name="purpose" data-testid="company-purpose" dir="auto" minLength={3} maxLength={1000} defaultValue={current?.purpose} required/></label>
 <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="company-reason" dir="auto" minLength={6} maxLength={500} required/></label><button className="primary-button" type="submit" data-testid="company-save">{t("save")}</button></fieldset></form>;
}
export function CompanyExpenseCancellation({current,disabled,send}:{current:CompanyExpensePlanView;disabled:boolean;send:CompanyExpenseSend}){
 const t=useTranslations("CompanyExpenses");return <form className="resource-form" data-testid="company-cancel-form" onSubmit={event=>{event.preventDefault();send({operation:"CANCEL",input:{id:current.id,expectedVersion:current.version,reason:companyExpenseFormText(new FormData(event.currentTarget).get("reason"))}});}}><fieldset disabled={disabled} className="resource-form"><legend>{t("cancel")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={6} maxLength={500} dir="auto" required/></label><button type="submit" className="secondary-button" data-testid="company-cancel">{t("cancel")}</button></fieldset></form>;
}
