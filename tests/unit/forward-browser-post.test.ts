import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { forwardBrowserPostOnce,forwardBrowserGetOnce } from "../e2e/support/forward-browser-post";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned ephemeral HTTP server required");
  return { server, url: `http://127.0.0.1:${address.port}/observed-command` };
}
const observed = (url: string, body = Buffer.from("original-command")) => ({ url: () => url, method: () => "POST", allHeaders: () => Promise.resolve({ "content-type": "text/plain;charset=UTF-8", cookie: "fixture=local-acceptance", "next-action": "fixture-action", "content-length": String(body.byteLength) }), postDataBuffer: () => body });

describe("single-attempt observed browser command forwarding", () => {
  it("preserves a private scoped GET query, cookies, device and scope headers, complete binary response and a fresh connection",async()=>{
    const requests:Array<{method:string|undefined;url:string|undefined;cookie:string|undefined;device:string|string[]|undefined;body:Buffer}>=[];let connections=0;
    const bytes=Buffer.from([0,255,12,128,1]),{server,url}=await listen((request,response)=>{const chunks:Buffer[]=[];request.on("data",(chunk:Buffer)=>chunks.push(chunk));request.on("end",()=>{requests.push({method:request.method,url:request.url,cookie:request.headers.cookie,device:request.headers["x-alvillas-device-id"],body:Buffer.concat(chunks)});response.writeHead(409,{"content-type":"application/octet-stream","cache-control":"private, no-store","x-reset":"original-scope"});response.end(bytes);});});server.on("connection",()=>connections++);
    const target=url+"?organization_id=owned-org&actor_user_id=owned-actor&cursor=opaque%2Boriginal",request={url:()=>target,method:()=>"GET",allHeaders:()=>Promise.resolve({cookie:"fixture=original-private-scope","x-alvillas-device-id":"original-device",referer:new URL(target).origin+"/ar/app/field/wallet"})};
    for(let index=0;index<2;index++){const result=await forwardBrowserGetOnce(request);expect(result.status).toBe(409);expect(result.headers).toMatchObject({"cache-control":"private, no-store","x-reset":"original-scope"});expect(result.body.equals(bytes)).toBe(true);}
    expect(connections).toBe(2);expect(requests).toHaveLength(2);for(const request of requests){expect(request).toMatchObject({method:"GET",url:"/observed-command?organization_id=owned-org&actor_user_id=owned-actor&cursor=opaque%2Boriginal",cookie:"fixture=original-private-scope",device:"original-device"});expect(request.body.byteLength).toBe(0);}
  });
  it("retains the original repeated response cookies as Playwright header text",async()=>{const{url}=await listen((_request,response)=>{response.writeHead(200,{"set-cookie":["fixture-a=original; HttpOnly","fixture-b=retained; SameSite=Strict"]});response.end("original body");});const result=await forwardBrowserGetOnce({url:()=>url,method:()=>"GET",allHeaders:()=>Promise.resolve({})});expect(result.headers["set-cookie"]).toBe("fixture-a=original; HttpOnly\nfixture-b=retained; SameSite=Strict");expect(result.body.toString()).toBe("original body");});
  it("exposes a private GET reset after one attempt without another request",async()=>{let attempts=0;const{url}=await listen(request=>{attempts++;request.socket.destroy();});await expect(forwardBrowserGetOnce({url:()=>url,method:()=>"GET",allHeaders:()=>Promise.resolve({})})).rejects.toMatchObject({code:"ECONNRESET"});expect(attempts).toBe(1);});
  it("rejects a changed method before forwarding a private GET",async()=>{await expect(forwardBrowserGetOnce(observed("http://127.0.0.1:1/scoped-read"))).rejects.toThrow("Observed HTTP browser GET required");});
  it("preserves exact body, identity headers and method while using a new socket for every observed command", async () => {
    const requests: Array<{ body: Buffer; method: string | undefined; cookie: string | undefined; action: string | string[] | undefined }> = [];
    let connections = 0;
    const { server, url } = await listen((request, response) => {
      const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => {
        requests.push({ body: Buffer.concat(chunks), method: request.method, cookie: request.headers.cookie, action: request.headers["next-action"] }); response.end("actual acknowledgement");
      });
    });
    server.on("connection", () => { connections++; });
    const body = Buffer.from('0:{"nonce":"original-once","reason":"Écriture / حركة"}');
    expect(await forwardBrowserPostOnce(observed(url, body))).toBe(200); expect(await forwardBrowserPostOnce(observed(url, body))).toBe(200);
    expect(requests).toHaveLength(2); expect(connections).toBe(2);
    for (const request of requests) { expect(request.body.equals(body)).toBe(true); expect(request).toMatchObject({ method: "POST", cookie: "fixture=local-acceptance", action: "fixture-action" }); }
  });
  it("waits for the complete server acknowledgement rather than only its headers", async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { release = resolve; });
    const { url } = await listen((_request, response) => { response.writeHead(200); response.write("accepted-header"); entered(); void done.then(() => response.end("committed-body")); });
    let settled = false; const forwarding = forwardBrowserPostOnce(observed(url)).then(status => { settled = true; return status; });
    await ready; expect(settled).toBe(false); release(); expect(await forwarding).toBe(200);
  });
  it("exposes a reset without retrying or replacing the original command", async () => {
    let attempts = 0;
    const { url } = await listen(request => { attempts++; request.socket.destroy(); });
    await expect(forwardBrowserPostOnce(observed(url))).rejects.toMatchObject({ code: "ECONNRESET" }); expect(attempts).toBe(1);
  });
  it("refuses unsupported observed requests before any forwarding", async () => {
    await expect(forwardBrowserPostOnce({ ...observed("http://127.0.0.1:1/command"), method: () => "GET" })).rejects.toThrow("Observed HTTP browser POST required");
    await expect(forwardBrowserPostOnce(observed("file:///local-command"))).rejects.toThrow("Observed HTTP browser POST required");
  });
});
