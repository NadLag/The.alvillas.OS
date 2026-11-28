import {z} from "zod";
import {localizedTextSchema,localizedText} from "@/i18n/content";
import {appLocales,type AppLocale} from "@/i18n/routing";

export const guestHubFormReferenceSchema=z.string().trim().min(1).max(1000).refine(value=>!/[\p{Cc}]/u.test(value));
export const guestHubFormBudgetSchema=z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict();
export const guestHubFormNoticeSchema=z.object({reference:guestHubFormReferenceSchema,title:localizedTextSchema.strict(),paragraphs:z.array(localizedTextSchema.strict()).min(1).max(30)}).strict();
export const guestHubRenderedFormNoticeSchema=z.object({title:guestHubFormNoticeSchema.shape.title.shape.en,paragraphs:z.array(guestHubFormNoticeSchema.shape.title.shape.en).min(1).max(30)}).strict();
export function renderGuestHubFormNotice(raw:unknown,locale:AppLocale){const notice=guestHubFormNoticeSchema.parse(raw),selected=z.enum(appLocales).parse(locale);return guestHubRenderedFormNoticeSchema.parse({title:localizedText(notice.title,selected),paragraphs:notice.paragraphs.map(paragraph=>localizedText(paragraph,selected))});}
export type GuestHubFormProcessingPolicy={enabled:boolean;processing_approval_reference:string|null;notice:z.infer<typeof guestHubFormNoticeSchema>|null};
export function retainsGuestHubFormPurpose(captured:GuestHubFormProcessingPolicy,current:GuestHubFormProcessingPolicy){return captured.enabled&&current.enabled&&Boolean(captured.processing_approval_reference)&&captured.processing_approval_reference===current.processing_approval_reference&&Boolean(captured.notice)&&JSON.stringify(captured.notice)===JSON.stringify(current.notice);}
export function intersectGuestHubFormFields<T extends string>(captured:{allowed_fields:readonly T[];required_fields:readonly T[]},current:{allowed_fields:readonly T[];required_fields:readonly T[]}){
 const allowed=captured.allowed_fields.filter(field=>current.allowed_fields.includes(field)),required=[...new Set([...captured.required_fields,...current.required_fields])];return !allowed.length||required.some(field=>!allowed.includes(field))?null:{allowed,required};
}
