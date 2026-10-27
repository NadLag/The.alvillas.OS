"use client";
import { useState,useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Props={currentPath:string;allPath?:string;properties:Array<{path:string;name:string}>;fromOn:string;toOn:string;currency:string;currencies:Array<{code:string}>;timezone:string};
export function OwnerLedgerFilters(props:Props){
  const t=useTranslations("OwnerLedger"),router=useRouter(),[pending,startTransition]=useTransition(),[error,setError]=useState(false);
  return <form className="resource-form owner-ledger-form" data-testid="owner-ledger-filters" aria-busy={pending} onSubmit={event=>{
    event.preventDefault();if(pending)return;const data=new FormData(event.currentTarget),target=data.get("ledgerPath"),from=data.get("fromOn"),to=data.get("toOn");
    if(typeof target!=="string"||![props.allPath,...props.properties.map(property=>property.path)].includes(target))return;
    if(typeof from!=="string"||typeof to!=="string"||from>to){setError(true);return}setError(false);
    const query=new URLSearchParams();for(const key of["fromOn","toOn","currency","timezone"]){const value=data.get(key);if(typeof value==="string"&&value)query.set(key,value)}
    startTransition(()=>router.push(target+"?"+query.toString()));
  }}>
    {error?<p role="alert">{t("invalidRange")}</p>:null}
    <fieldset disabled={pending}><legend>{t("filters")}</legend><div className="form-grid">
      <label className="field"><span>{t("property")}</span><select name="ledgerPath" data-testid="owner-ledger-property" defaultValue={props.currentPath} required>
        {props.allPath?<option value={props.allPath}>{t("allProperties")}</option>:null}{props.properties.map(property=><option key={property.path} value={property.path}>{property.name}</option>)}
      </select></label>
      <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="owner-ledger-currency" defaultValue={props.currency} required>{props.currencies.map(currency=><option value={currency.code} key={currency.code}>{currency.code}</option>)}</select></label>
      <label className="field"><span>{t("fromOn")}</span><input name="fromOn" data-testid="owner-ledger-from" type="date" defaultValue={props.fromOn} required/></label>
      <label className="field"><span>{t("toOn")}</span><input name="toOn" data-testid="owner-ledger-to" type="date" defaultValue={props.toOn} required/></label>
      <label className="field"><span>{t("timezone")}</span><input name="timezone" data-testid="owner-ledger-timezone" value={props.timezone} readOnly/></label>
    </div><div className="form-actions"><button className="primary-button" type="submit" data-testid="owner-ledger-apply">{t(pending?"loading":"apply")}</button></div></fieldset>
  </form>;
}
