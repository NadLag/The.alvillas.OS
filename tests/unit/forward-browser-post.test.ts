import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { forwardBrowserPostOnce } from "../e2e/support/forward-browser-post";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned ephemeral HTTP server required");
  return { server, url: `http://127.0.0.1:${address.port}/observed-command` };
}
const observed = (url: string, body = Buffer.from("original-command")) => ({ url: () => url, method: () => "POST", allHeaders: () => Promise.resolve({ "content-type": "text/plain;charset=UTF-8", cookie: "fixture=local-acceptance", "next-action": "fixture-action", "content-length": String(body.byteLength) }), postDataBuffer: () => body });

describe("single-attempt observed browser command forwarding", () => {
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
