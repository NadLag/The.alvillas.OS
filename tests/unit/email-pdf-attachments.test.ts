import {createHash} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import type {EmailProvider} from "@/platform/providers";
import {ResendEmailProvider,type HttpTransport} from "@/platform/providers/real";
import {EmailAttachmentValidationError,emailAttachmentTransportMaximumBytes,requireEmailAttachmentTransportSize,validateEmailPdfAttachments} from "@/platform/providers/email-attachments";

const pdf=(value:string)=>Buffer.from("%PDF-1.7\n"+value+"\n%%EOF\n").toString("base64");
const attached={filename:"owner-package-en.pdf",content:pdf("Original English PDF"),contentType:"application/pdf"as const};
const input:Parameters<EmailProvider["send"]>[0]={to:"owner@example.test",subject:"Original package",html:"<p>Original package</p>",text:"Original package",locale:"en",template:"onboarding.owner_package"};
function transport(){return vi.fn<HttpTransport>(()=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({id:"local-owned-email-reference"}),text:()=>Promise.resolve(""),arrayBuffer:()=>Promise.resolve(new ArrayBuffer(0))}));}
const provider=(send:HttpTransport)=>new ResendEmailProvider({RESEND_API_KEY:"local_fixture_only",EMAIL_FROM:"operations@example.test"},send);

describe("native email PDF attachments",()=>{
 it("preserves the exact original request and fallback key for an existing email without attachments",async()=>{
  const send=transport();await provider(send).send(input);const body=JSON.parse(send.mock.calls[0][1].body!)as Record<string,unknown>;
  expect(body).not.toHaveProperty("attachments");expect(send.mock.calls[0][1].headers?.["Idempotency-Key"]).toBe("email:"+createHash("sha256").update(JSON.stringify(input)).digest("hex"));
 });
 it("sends both original byte sequences with the documented filename/content wire shape",async()=>{
  const send=transport(),fr={...attached,filename:"owner-package-fr.pdf",content:pdf("Dossier français original")};await provider(send).send({...input,attachments:[attached,fr]});
  const body=JSON.parse(send.mock.calls[0][1].body!)as{attachments:Array<{filename:string;content:string}>};
  expect(body.attachments).toEqual([attached,fr].map(({filename,content})=>({filename,content})));expect(body.attachments.map(row=>Buffer.from(row.content,"base64"))).toEqual([attached,fr].map(row=>Buffer.from(row.content,"base64")));
 });
 it("binds changed attachment bytes and names into the fallback idempotency key",async()=>{
  const send=transport(),mail=provider(send);for(const item of[attached,{...attached,content:pdf("Corrected original")},{...attached,filename:"owner-package-fr.pdf"}])await mail.send({...input,attachments:[item]});
  expect(new Set(send.mock.calls.map(call=>call[1].headers?.["Idempotency-Key"])).size).toBe(3);
 });
 it("retains an explicit canonical delivery key and delivery receipt tags",async()=>{
  const send=transport(),reference={organizationId:crypto.randomUUID(),deliveryId:crypto.randomUUID()};await provider(send).send({...input,attachments:[attached],idempotencyKey:"original-paired-delivery:one",deliveryReference:reference});
  expect(send.mock.calls[0][1].headers?.["Idempotency-Key"]).toBe("original-paired-delivery:one");const body=JSON.parse(send.mock.calls[0][1].body!)as{tags:Array<{name:string;value:string}>};expect(body.tags).toContainEqual({name:"organization_id",value:reference.organizationId});expect(body.tags).toContainEqual({name:"delivery_id",value:reference.deliveryId});
 });
 it.each([
  [],[{...attached,path:"https://private.example.test/document.pdf"}],[{...attached,filename:"../private.pdf"}],[{...attached,filename:"original.pdf\r\nBcc:other@example.test"}],
  [{...attached,content:"https://private.example.test/document.pdf"}],[{...attached,content:Buffer.from("Other bytes").toString("base64")}],[{...attached,content:attached.content+"\n"}],
  [{...attached,contentType:"text/html"}],[attached,{...attached,content:pdf("Different bytes under a duplicate name")}],[attached,{...attached,filename:"OWNER-PACKAGE-EN.pdf"}]
 ].map((raw,index)=>({raw,index})))("rejects unsafe or noncanonical attachment case $index without a provider request",async({raw})=>{
  const send=transport();expect(()=>validateEmailPdfAttachments(raw)).toThrow(EmailAttachmentValidationError);
  await expect(provider(send).send({...input,attachments:raw as typeof attached[]})).rejects.toBeInstanceOf(EmailAttachmentValidationError);expect(send).not.toHaveBeenCalled();
 });
 it("rejects an oversized aggregate before decoding attachment bytes",()=>{expect(()=>validateEmailPdfAttachments([{...attached,content:"A".repeat(emailAttachmentTransportMaximumBytes+1)}])).toThrow(EmailAttachmentValidationError);});
 it("bounds the complete encoded request without truncating an attachment",()=>{expect(()=>requireEmailAttachmentTransportSize("a".repeat(emailAttachmentTransportMaximumBytes),true)).not.toThrow();expect(()=>requireEmailAttachmentTransportSize("a".repeat(emailAttachmentTransportMaximumBytes+1),true)).toThrow(EmailAttachmentValidationError);});
});
