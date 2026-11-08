import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {describe,it,expect} from "vitest";
import type {Page} from "@playwright/test";
import {forwardBrowserPostOnce,postBrowserJsonOnce} from "../e2e/support/forward-browser-post";

const browser=()=>({context:()=>({cookies:()=>Promise.resolve([{name:"owned_fixture_session",value:"synthetic"}])}),evaluate:()=>Promise.resolve("Owned transport test agent")} as unknown as Pick<Page,"context"|"evaluate">);
async function listen(server:Server){server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("Owned local test server required");return"http://127.0.0.1:"+address.port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
describe("single-attempt authenticated browser fixture transport",()=>{
 it("retains complete original JSON, exact monetary strings, credentials and nonce on one observed POST",async()=>{
  const observed:Array<{body:unknown;cookie:string|undefined;agent:string|undefined;connection:string|undefined}>=[],data={idempotencyKey:"owned-original-nonce",amount:"9007199254740993.07",currency:"MAD"},server=createServer((request,response)=>{void(async()=>{const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));observed.push({body:JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,cookie:request.headers.cookie,agent:request.headers["user-agent"],connection:request.headers.connection});response.writeHead(200,{"content-type":"application/json"});response.write('{"amount":"9007199254740993.07",');response.end('"currency":"MAD"}');})().catch(()=>response.destroy());});const origin=await listen(server);
  try{const result=await postBrowserJsonOnce(browser(),"/runs",{headers:{origin},data});expect(result.status()).toBe(200);expect(await result.json()).toEqual({amount:data.amount,currency:"MAD"});expect(observed).toEqual([{body:data,cookie:"owned_fixture_session=synthetic",agent:"Owned transport test agent",connection:"close"}]);}finally{await close(server);}
 });
 it("opens independent connections for commands separated by another completed request",async()=>{
  let connections=0,requests=0;const server=createServer((_request,response)=>{requests++;response.writeHead(200,{"content-type":"application/json"});response.end('{"recorded":true}');});server.on("connection",()=>connections++);const origin=await listen(server);
  try{for(const idempotencyKey of["first-original","second-original"]){const response=await postBrowserJsonOnce(browser(),"/runs",{headers:{origin},data:{idempotencyKey}});expect(await response.json()).toEqual({recorded:true});}expect(requests).toBe(2);expect(connections).toBe(2);}finally{await close(server);}
 });
 it("never repeats or replaces an unknown original command after a real reset",async()=>{
  const observed:unknown[]=[];const server=createServer(request=>{void(async()=>{const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);request.socket.destroy();})().catch(()=>request.socket.destroy());}),origin=await listen(server),data={idempotencyKey:"retain-this-original-nonce"};
  try{await expect(postBrowserJsonOnce(browser(),"/runs",{headers:{origin},data})).rejects.toMatchObject({code:"ECONNRESET"});expect(observed).toEqual([data]);}finally{await close(server);}
 });
 it("rejects another origin before exporting any browser credentials and preserves the original status-only caller",async()=>{
  let credentialsRead=false;const denied={context:()=>{credentialsRead=true;throw Error("Credentials must not be read");}}as unknown as Pick<Page,"context"|"evaluate">;await expect(postBrowserJsonOnce(denied,"https://outside.example.test/runs",{headers:{origin:"http://127.0.0.1:3000"},data:{}})).rejects.toThrow("Same-origin owned browser POST required");expect(credentialsRead).toBe(false);
  const server=createServer((_request,response)=>{response.writeHead(202);response.end("complete acknowledgement");}),origin=await listen(server);try{expect(await forwardBrowserPostOnce({url:()=>origin+"/observed",method:()=>"POST",allHeaders:()=>Promise.resolve({"content-type":"application/json"}),postDataBuffer:()=>Buffer.from("{}")})).toBe(202);}finally{await close(server);}
 });
});
