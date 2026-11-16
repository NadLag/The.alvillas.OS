"use client";
import {useTranslations} from "next-intl";
export function TransferServiceFields({enabled,onChange}:{enabled:boolean;onChange:(enabled:boolean)=>void}){const t=useTranslations("Transfers");return<section data-testid="transfer-service-fields"><label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={event=>onChange(event.target.checked)}/>{t("service")}</label>{enabled?<p>{t("serviceHelp")}</p>:null}</section>;}
