import {createElement} from "react";
import {resolve} from "node:path";
import type {IncomingMessage,ServerResponse} from "node:http";
import {Document,Page,Text,Font,renderToBuffer} from "@react-pdf/renderer";
import {documentPdfInputSchema,documentPdfTemplate,validateGeneratedPdf} from "@/modules/documents/domain/document-pdf";

/** Owned provider fixture: exercise the configured HTTP boundary with actual Arabic glyphs. */
export async function renderOwnedProposal(request:IncomingMessage,response:ServerResponse,token:string){
 if(request.headers.authorization!=="Bearer "+token){response.writeHead(401).end();return;}
 const chunks:Buffer[]=[];let length=0;for await(const chunk of request as AsyncIterable<Uint8Array>){length+=chunk.length;if(length>2*1024*1024)throw Error("Owned renderer input exceeded its fixture bound");chunks.push(Buffer.from(chunk));}
 const input=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {template?:unknown;locale?:unknown;data?:unknown},payload=documentPdfInputSchema.parse(input.data);
 if(input.template!==documentPdfTemplate||input.locale!=="ar"||payload.source.locale!=="ar")throw Error("Owned Arabic renderer received another contract");
 const family="OwnedProposalNotoArabic";Font.register({family,src:resolve(process.cwd(),"tests/fixtures/fonts/NotoSansArabic-Variable.ttf")});
 const pdf=createElement(Document,{title:payload.source.title,language:"ar",creator:"Owned ALVILLAS acceptance renderer"},
  createElement(Page,{size:"A4",style:{fontFamily:family,fontSize:11,padding:40,textAlign:"right"}},
   createElement(Text,{style:{fontSize:20,marginBottom:20}},payload.source.title),
   ...payload.source.blocks.map((block,index)=>createElement(Text,{key:index,style:{marginBottom:10}},block.text))));
 const bytes=validateGeneratedPdf(new Uint8Array(await renderToBuffer(pdf)),payload.maximumBytes);
 response.writeHead(200,{"content-type":"application/pdf","content-length":bytes.length}).end(bytes);
}
