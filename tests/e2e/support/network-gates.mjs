import { Buffer } from "node:buffer";
import { Server } from "node:http";
import process from "node:process";
import { URL } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (process.env.VERCEL || process.env.VERCEL_ENV || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
  process.env.R2_ACCOUNT_ID !== "alvillas-e2e-local") throw new Error("Network gates require an isolated local test server");
const gates = new Map(), emit = Server.prototype.emit;
const bytes = (chunk, encoding) => typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk);
const state = gate => ({ mode: gate.mode, blocked: gate.blocked, forwarded: gate.forwarded, heldResponses: gate.responses, workerRevision: gate.workerRevision });

// Delay actual HTTP responses below the application. Browser worker sessions,
// application handlers, cookies, authorization, PostgreSQL and response bytes
// remain native. No route or control endpoint is included in a deployment.
Server.prototype.emit = function (event, ...args) {
  if (event !== "request") return Reflect.apply(emit, this, [event, ...args]);
  const [req, res] = args, path = new URL(req.url, "http://127.0.0.1:3000").pathname;
  const control = path.match(/^\/__alvillas_e2e\/network\/([a-f0-9-]{36})$/u);
  if (control) {
    const gate = gates.get(control[1]) ?? { mode: "open", blocked: 0, forwarded: 0, responses: [], releases: new Set() };
    gates.set(control[1], gate); res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET") { res.end(JSON.stringify(state(gate))); return true; }
    if (req.method !== "POST") { res.statusCode = 405; res.end(); return true; }
    let body = ""; req.on("data", chunk => { body += String(chunk); if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const value = JSON.parse(body); if (!["open", "unavailable", "hold"].includes(value.mode)) throw new Error("Invalid gate");
        if (value.workerRevision !== undefined && !/^[a-f0-9-]{36}$/u.test(value.workerRevision)) throw new Error("Invalid worker revision");
        gate.workerRevision = value.workerRevision ?? gate.workerRevision;
        gate.mode = value.mode; if (gate.mode === "open") for (const release of [...gate.releases]) release();
        res.end(JSON.stringify(state(gate)));
      } catch { res.statusCode = 400; res.end(); }
    }); return true;
  }
  const cookie = (req.headers.cookie ?? "").split(";").map(value => value.trim()).find(value => value.startsWith("alvillas_e2e_network="))?.split("=")[1];
  const gate = typeof cookie === "string" ? gates.get(cookie) : undefined;
  if (gate?.workerRevision && path === "/sw.js") {
    // A deployment updates bytes at the same worker URL. Keep the application
    // worker intact and append only a release comment for this private browser.
    req.headers["accept-encoding"] = "identity"; delete req.headers["if-none-match"]; delete req.headers["if-modified-since"];
    const chunks = [], write = res.write, end = res.end, flush = res.flushHeaders, writeHead = res.writeHead;
    res.writeHead = function (status, message, headers) {
      this.statusCode = status;
      if (typeof message === "string") this.statusMessage = message;
      const values = typeof message === "string" ? headers : message;
      if (Array.isArray(values)) { for (let index = 0; index < values.length; index += 2) this.setHeader(values[index], values[index + 1]); }
      else if (values) { for (const [name, value] of Object.entries(values)) this.setHeader(name, value); }
      return this;
    };
    res.flushHeaders = function () {};
    res.write = function (chunk, encoding, callback) { chunks.push(bytes(chunk, encoding)); const done = typeof encoding === "function" ? encoding : callback; if (done) globalThis.queueMicrotask(done); return true; };
    res.end = function (chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(bytes(chunk, encoding));
      res.write = write; res.end = end; res.flushHeaders = flush; res.writeHead = writeHead;
      res.removeHeader("content-length"); res.removeHeader("etag");
      const body = Buffer.concat([...chunks, Buffer.from(`\n// Local browser release ${gate.workerRevision}\n`)]);
      return Reflect.apply(end, this, [body, typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback]);
    };
    return Reflect.apply(emit, this, [event, ...args]);
  }
  if (!gate || path !== "/api/sync/push" || req.method !== "POST") return Reflect.apply(emit, this, [event, ...args]);
  if (gate.mode === "unavailable") { gate.blocked += 1; req.resume(); res.statusCode = 503; res.end(); return true; }
  gate.forwarded += 1;
  if (gate.mode === "hold") {
    const chunks = [], write = res.write, end = res.end, flush = res.flushHeaders; let ended = false, released = false, callback;
    const release = () => {
      if (released || !ended) return; released = true; gate.releases.delete(release);
      res.write = write; res.end = end; res.flushHeaders = flush;
      if (!res.destroyed) Reflect.apply(end, res, [Buffer.concat(chunks), callback]);
    };
    res.flushHeaders = function () { if (released) return Reflect.apply(flush, this, []); };
    res.write = function (chunk, encoding, done) {
      if (released) return Reflect.apply(write, this, [chunk, encoding, done]);
      chunks.push(bytes(chunk, encoding)); const complete = typeof encoding === "function" ? encoding : done; if (complete) globalThis.queueMicrotask(complete); return true;
    };
    res.end = function (chunk, encoding, done) {
      if (released) return Reflect.apply(end, this, [chunk, encoding, done]);
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(bytes(chunk, encoding));
      callback = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : done; ended = true;
      let results = [];
      try {
        let body = Buffer.concat(chunks); const encoding = res.getHeader("content-encoding");
        if (encoding === "gzip") body = gunzipSync(body); else if (encoding === "br") body = brotliDecompressSync(body); else if (encoding === "deflate") body = inflateSync(body);
        const data = JSON.parse(body.toString("utf8")); if (Array.isArray(data.results)) results = data.results.map(item => item.status);
      } catch { /* The original status and bytes still pass through unchanged. */ }
      gate.responses.push({ status: res.statusCode, results }); gate.releases.add(release);
      if (gate.mode === "open") release(); return this;
    };
    res.once("close", () => gate.releases.delete(release));
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
