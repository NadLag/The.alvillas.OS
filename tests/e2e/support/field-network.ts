import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { z } from "zod";
import { forwardBrowserGetOnce, forwardBrowserPostOnce } from "./forward-browser-post";

const state = z.object({ mode: z.enum(["open", "unavailable", "hold"]), blocked: z.number(), forwarded: z.number(),
  heldResponses: z.array(z.object({ status: z.number(), results: z.array(z.string()) })), workerRevision: z.string().optional() });
export async function fieldNetwork(context: BrowserContext, mode: "unavailable" | "hold") {
  const gate = randomUUID();
  const origin = "http://127.0.0.1:3000";
  const url = () => `${origin}/__alvillas_e2e/network/${gate}`;
  let currentMode: "open" | "unavailable" | "hold" = mode;
  const configure = async (mode: "open" | "unavailable" | "hold", workerRevision?: string) => {
    const data = Buffer.from(JSON.stringify({ mode, workerRevision }));
    let body = "";
    const status = await forwardBrowserPostOnce({
      url,
      method: () => "POST",
      allHeaders: () => Promise.resolve({ "content-type": "application/json", "content-length": String(data.byteLength) }),
      postDataBuffer: () => data
    }, response => { body = response.toString("utf8"); });
    expect(status).toBe(200);
    currentMode = mode;
    return state.parse(JSON.parse(body));
  };
  await configure(mode);
  await context.addCookies([{ name: "alvillas_e2e_network", value: gate, url: origin + "/", httpOnly: true, sameSite: "Strict" }]);
  return { state: async () => {
      const response = await forwardBrowserGetOnce({ url, method: () => "GET", allHeaders: () => Promise.resolve({}) });
      expect(response.status).toBe(200);
      return state.parse(JSON.parse(response.body.toString("utf8")));
    },
    revision: async (value: string) => { await configure(currentMode, value); },
    release: async () => { await configure("open"); },
    close: async () => { await configure("open"); } };
}
