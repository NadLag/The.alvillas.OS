import { R2StorageProvider } from "@/platform/providers/real";
import { FinancialAttachmentObjectStore } from "../infrastructure/financial-attachment-storage";

export function configuredFinancialAttachmentObjects() { return new FinancialAttachmentObjectStore(new R2StorageProvider()); }
