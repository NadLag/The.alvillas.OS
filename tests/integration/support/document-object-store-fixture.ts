import {createServer} from "node:http";
import {DocumentObjectStore} from "@/modules/documents/infrastructure/document-object-store";

/** Real conditional encrypted-object HTTP I/O stays on an owned ephemeral loopback listener. */
export async function nativeDocumentObjectFixture(env:NodeJS.ProcessEnv){
 if(process.env.VERCEL||process.env.VERCEL_ENV)throw Error("Owned local document fixture required");
 const bytes=new Map<string,Buffer>(),server=createServer((request,response)=>{void(async()=>{
  const key=request.url??"";if(request.method==="PUT"){if(request.headers["if-none-match"]!=="*"||request.headers["content-type"]!=="application/octet-stream"){response.writeHead(400).end();return;}const chunks:Buffer[]=[];for await(const chunk of request as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(chunk));if(bytes.has(key))response.writeHead(412).end();else{bytes.set(key,Buffer.concat(chunks));response.writeHead(200).end();}return;}
  if(request.method!=="GET"){response.writeHead(405).end();return;}const original=bytes.get(key);if(original)response.writeHead(200,{"content-length":original.length}).end(original);else response.writeHead(404).end();
 })().catch(()=>response.destroy());});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Actual loopback storage listener required");const origin="http://127.0.0.1:"+address.port;
 const objects=new DocumentObjectStore({createSignedUploadUrl:({key})=>Promise.resolve({url:origin+"/"+encodeURIComponent(key)}),createSignedDownloadUrl:({key})=>Promise.resolve({url:origin+"/"+encodeURIComponent(key)})},fetch,env);
 return{objects,storedObjects:()=>bytes.size,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
