"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {AppLocale} from "@/i18n/routing";
import {localizedText} from "@/i18n/content";
import {onboardingConfigurationFamilies,type onboardingConfigurationValidationSchema} from "../domain/onboarding-configuration";
import {onboardingReviewOwnerFields,onboardingReviewPropertyFields} from "../domain/onboarding-review-policy";
import {OnboardingPropertyRecord} from "./onboarding-property-record";
import {OnboardingOperatingValues} from "./onboarding-operating-record";
import {OnboardingManagementAgreementValues} from "./onboarding-management-agreement-record";
import {OnboardingTeamValues} from "./onboarding-team-record";
import {ChannelValues} from "./onboarding-booking-channels-record";
import {InventorySettings} from "./onboarding-inventory-record";
import {ServicesSettings} from "./onboarding-services-record";
import {WorkflowsSettings} from "./onboarding-workflows-record";

export function OnboardingConfigurationRecord({validation,reason,locale}:{validation:z.infer<typeof onboardingConfigurationValidationSchema>;reason:string;locale:AppLocale}){
 const t=useTranslations("OnboardingWizard"),facts=validation.facts;
 const issueField=(issue:typeof validation.issues[number])=>{if(issue.code!=="REQUIRED_FIELD")return null;const[family,field]=issue.path.split("/");if(family==="owner"&&issue.family==="owner"&&onboardingReviewOwnerFields.some(value=>value===field))return t("fields."+field);if(family==="property"&&issue.family==="property"&&onboardingReviewPropertyFields.some(value=>value===field))return t("property.fields."+(field==="cityId"?"city":field==="regionId"?"region":field));return null;};
 const catalog=(family:"inventory"|"services"|"workflows")=>{const value=facts[family];return value?.template?<p dir="auto">{t("configuration.template",{name:localizedText(value.template.name,locale),version:value.templateRevision??0})}</p>:null;};
 return <section className="resource-form" data-testid="onboarding-configuration-record"><p role="status" data-testid="onboarding-configuration-ready">{t(validation.ready?"configuration.ready":"configuration.blocked",{count:validation.issues.length})}</p>{!validation.ready&&<section className="resource-form" aria-label={t("configuration.blockingErrors")} data-testid="onboarding-configuration-issues"><h3>{t("configuration.blockingErrors")}</h3><p>{t("configuration.correctionGuidance")}</p><ul className="onboarding-list">{validation.issues.map((issue,index)=><li key={index}><strong>{t("configuration.families."+issue.family)}</strong>{issueField(issue)&&<p>{issueField(issue)}</p>}<p>{t("configuration.issues."+issue.code)}</p></li>)}</ul></section>}
  {onboardingConfigurationFamilies.map(family=><details className="resource-form" key={family} data-testid={"onboarding-configuration-"+family}><summary>{t("configuration.families."+family)} · {t(validation.issues.some(issue=>issue.family===family)?"configuration.needsAttention":"configuration.checked")}</summary>
   {!facts[family]?<p>{t("configuration.sourceUnavailable")}</p>:<>
    {family==="owner"&&facts.owner&&<dl className="onboarding-values">{(["displayName","email","phone"]as const).map(key=><div key={key}><dt>{t("fields."+key)}</dt><dd dir={key==="displayName"?"auto":"ltr"}>{facts.owner![key]??t("property.noValue")}</dd></div>)}<div><dt>{t("fields.preferredLocale")}</dt><dd>{t("languages."+facts.owner.preferredLocale)}</dd></div></dl>}
    {family==="property"&&facts.owner&&facts.property&&<OnboardingPropertyRecord review={{owner:facts.owner,property:facts.property}} reason={reason}/>}
    {family==="operatingProfile"&&<><OnboardingOperatingValues profile={facts.operatingProfile}/>{facts.operatingRule&&<dl className="onboarding-values"><div><dt>{t("operating.ruleVersion")}</dt><dd>{facts.operatingRule.version}</dd></div><div><dt>{t("operating.ruleNights")}</dt><dd>{facts.operatingRule.nights}</dd></div><div><dt>{t("operating.ruleTemplate")}</dt><dd dir="auto">{facts.operatingRule.taskTemplateKey??t("property.noValue")}</dd></div></dl>}</>}
    {family==="agreement"&&facts.agreement&&(validation.issues.some(issue=>issue.family==="agreement"&&issue.code==="INVALID_SOURCE")?<p>{t("configuration.sourceUnavailable")}</p>:<OnboardingManagementAgreementValues agreement={facts.agreement} locale={locale}/>)}
    {family==="team"&&facts.team&&<><OnboardingTeamValues team={facts.team}/><dl className="onboarding-values">{facts.team.people.map(row=><div key={row.id}><dt dir="auto">{row.displayName}</dt><dd>{t(row.archivedAt?"configuration.inactive":"configuration.active")}</dd></div>)}{facts.team.accounts.map(row=><div key={row.id}><dt dir="auto">{row.email}</dt><dd>{t(row.status==="ACTIVE"?"configuration.active":"configuration.inactive")}</dd></div>)}{facts.team.roles.map(row=><div key={row.id}><dt dir="auto">{row.name}</dt><dd>{t(row.archivedAt?"configuration.inactive":"configuration.active")}</dd></div>)}</dl></>}
    {family==="bookingChannels"&&facts.bookingChannels&&<ChannelValues rows={facts.bookingChannels.channels}/>}
    {family==="inventory"&&facts.inventory&&<>{catalog("inventory")}<InventorySettings settings={facts.inventory.settings}/></>}
    {family==="services"&&facts.services&&<>{catalog("services")}<ServicesSettings settings={facts.services.settings}/></>}
    {family==="workflows"&&facts.workflows&&<>{catalog("workflows")}<WorkflowsSettings settings={facts.workflows.settings}/>{facts.workflowReferences.length>0&&<section className="resource-form"><h4>{t("configuration.references")}</h4><ul className="onboarding-list">{facts.workflowReferences.map(row=><li key={row.key}><strong dir="ltr">{row.key}</strong><p>{t(row.id&&row.valid?"configuration.referenceReady":"configuration.referenceBlocked",{version:row.version??0})}</p>{row.taskTemplateKey&&<p dir="auto">{t("configuration.taskReference",{key:row.taskTemplateKey})}</p>}</li>)}</ul></section>}</>}
   </>}
  </details>)}<dl className="onboarding-values"><div><dt>{t("reason")}</dt><dd dir="auto" className="onboarding-private-text">{reason}</dd></div></dl>
 </section>;
}
