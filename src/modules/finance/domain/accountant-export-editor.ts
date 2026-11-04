import { z } from "zod";
import { appLocales } from "@/i18n/routing";
import { accountantReportKinds, accountantExportFormats } from "./accountant-export";

export const accountantChoiceKinds = ["property", "owner", "bank"] as const;
export const accountantEditorInputSchema = z.object({ locale: z.enum(appLocales), currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  choice: z.enum(accountantChoiceKinds).optional(), query: z.string().trim().max(120).default(""), after: z.uuid().optional() }).strict();
export const accountantEditorSchema = z.object({ reports: z.array(z.enum(accountantReportKinds)), formats: z.array(z.enum(accountantExportFormats)),
  currency: z.string().regex(/^[A-Z]{3}$/u), currencies: z.array(z.string().regex(/^[A-Z]{3}$/u)), timezone: z.string(), fromOn: z.iso.date(), toOn: z.iso.date(),
  choices: z.array(z.object({ id: z.uuid(), label: z.string() }).strict()), next: z.uuid().nullable(), arabicPdfAvailable: z.boolean() }).strict();
export type AccountantExportEditor = z.infer<typeof accountantEditorSchema>;
