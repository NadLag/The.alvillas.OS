import {z} from "zod";
import {localizedText,type LocalizedText} from "@/i18n/content";
import {appLocales,type AppLocale} from "@/i18n/routing";
import {guestHubFormNoticeSchema} from "./guest-hub-form-policy";

export const guestHubHouseRulesLocaleSchema=z.enum(appLocales);
export const guestHubHouseRulesContentSchema=z.object({
 title:guestHubFormNoticeSchema.shape.title,
 rules:guestHubFormNoticeSchema.shape.paragraphs,
 acceptanceStatement:guestHubFormNoticeSchema.shape.title
}).strict();
export type GuestHubHouseRulesContent=z.infer<typeof guestHubHouseRulesContentSchema>;

/** One complete approved language is used for the rules and acknowledgement.
 * Partial optional Arabic wording cannot produce an unrecorded mixed edition. */
export function renderGuestHubHouseRulesContent(raw:unknown,requested:AppLocale){
 const content=guestHubHouseRulesContentSchema.parse(raw),requestedLocale=guestHubHouseRulesLocaleSchema.parse(requested),texts:LocalizedText[]=[content.title,...content.rules,content.acceptanceStatement],locale=requestedLocale==="ar"&&texts.some(text=>!text.ar)?"en":requestedLocale;
 return{requestedLocale,locale,title:localizedText(content.title,locale),rules:content.rules.map(rule=>localizedText(rule,locale)),acceptanceStatement:localizedText(content.acceptanceStatement,locale)};
}
export function renderGuestHubHouseRulesNotice(raw:unknown,locale:AppLocale){
 const notice=guestHubFormNoticeSchema.parse(raw),selected=guestHubHouseRulesLocaleSchema.parse(locale);
 return{title:localizedText(notice.title,selected),paragraphs:notice.paragraphs.map(paragraph=>localizedText(paragraph,selected))};
}
