import { serve } from "inngest/next";
import { inngest, inngestFunctions } from "@/platform/events/inngest-functions";

export const runtime = "nodejs";
export const { GET, POST, PUT } = serve({ client: inngest, functions: inngestFunctions,
  serveOrigin: process.env.APP_URL, servePath: "/api/inngest" });
