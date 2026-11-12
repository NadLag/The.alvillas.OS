import {z} from "zod";

export type EmailPdfAttachment={filename:string;content:string;contentType:"application/pdf"};
// Resend's documented transport ceiling includes Base64 attachment encoding.
// https://resend.com/docs/api-reference/emails/send-email
export const emailAttachmentTransportMaximumBytes=40_000_000;
const attachment=z.object({filename:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,174}\.pdf$/u),content:z.string().min(8),contentType:z.literal("application/pdf")}).strict();
const attachments=z.array(attachment).min(1).max(1024);
export class EmailAttachmentValidationError extends Error{constructor(){super("Invalid email PDF attachment or transport size");}}

/** Only already-read PDF bytes cross this boundary; hosted paths and storage URLs are never accepted. */
export function validateEmailPdfAttachments(raw:unknown):EmailPdfAttachment[]|undefined{
 if(raw===undefined)return undefined;
 try{
  const parsed=attachments.parse(raw);let encodedBytes=0;const filenames=new Set<string>();
  for(const item of parsed){encodedBytes+=Buffer.byteLength(item.content,"utf8");if(encodedBytes>emailAttachmentTransportMaximumBytes||filenames.has(item.filename.toLowerCase()))throw new EmailAttachmentValidationError();filenames.add(item.filename.toLowerCase());}
  for(const item of parsed){const bytes=Buffer.from(item.content,"base64");if(bytes.toString("base64")!==item.content||bytes.subarray(0,5).toString("ascii")!=="%PDF-")throw new EmailAttachmentValidationError();}
  return parsed;
 }catch{throw new EmailAttachmentValidationError();}
}

export function requireEmailAttachmentTransportSize(body:string,hasAttachments:boolean){if(hasAttachments&&Buffer.byteLength(body,"utf8")>emailAttachmentTransportMaximumBytes)throw new EmailAttachmentValidationError();}
