import en from "../../../messages/en.json" with {type:"json"};
import fr from "../../../messages/fr.json" with {type:"json"};
import ar from "../../../messages/ar.json" with {type:"json"};
import type {EmailProvider} from "@/platform/providers";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {escapeHtml} from "@/platform/encoding/html";
import {onboardingOwnerDeliverySourceSchema} from "@/modules/onboarding/domain/onboarding-owner-delivery";
import {renderEmailDocument} from "./email-layout";

const catalogs={en,fr,ar};
type OriginalEmail=Pick<Parameters<EmailProvider["send"]>[0],"to"|"subject"|"html"|"text"|"locale"|"template">;
/** Generate every approved original; delivery selects the actual owner's configured language without fallback. */
export function renderOnboardingOwnerPackageEmails(raw:unknown){
 const source=onboardingOwnerDeliverySourceSchema.parse(raw),variants:OriginalEmail[]=[];
 for(const locale of source.policy.locales){
  const labels=catalogs[locale].emailTemplates.ownerPackage,subject=labels.subject.replace("{property}",()=>source.propertyName.replace(/[\r\n\u2028\u2029]+/gu," "));
  const lines=[labels.greeting.replace("{owner}",()=>source.ownerName),labels.body,labels.footer],text=lines.join("\n\n"),html=renderEmailDocument(locale,subject,lines.map(line=>"<p>"+escapeHtml(line)+"</p>").join(""));
  variants.push({to:source.ownerEmail,subject,text,html,locale,template:"onboarding.owner_package"});
 }
 const selected=variants.find(row=>row.locale===source.ownerLocale);if(!selected)throw Error("Approved original owner email language required");
 return{source,variants,selected,fingerprint:jsonbFingerprint({source,variants})};
}
