import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { z } from "zod";

const state = z.object({ mode: z.enum(["open", "unavailable", "hold"]), blocked: z.number(), forwarded: z.number(),
  heldResponses: z.array(z.object({ status: z.number(), results: z.array(z.string()) })), workerRevision: z.string().optional() });
export async function fieldNetwork(context: BrowserContext, mode: "unavailable" | "hold") {
  const path = `/__alvillas_e2e/network/${randomUUID()}`;
  let currentMode: "open" | "unavailable" | "hold" = mode;
  const configure = async (mode: "open" | "unavailable" | "hold", workerRevision?: string) => {
    const response = await context.request.post(path, { data: { mode, workerRevision } }); expect(response.status()).toBe(200); currentMode = mode; return state.parse(await response.json());
  };
  await configure(mode);
  await context.addCookies([{ name: "alvillas_e2e_network", value: path.split("/").at(-1)!, url: "http://127.0.0.1:3000/", httpOnly: true, sameSite: "Strict" }]);
  return { state: async () => state.parse(await (await context.request.get(path)).json()),
    revision: async (value: string) => { await configure(currentMode, value); },
    release: async () => { await configure("open"); },
    close: async () => { await configure("open"); } };
}
