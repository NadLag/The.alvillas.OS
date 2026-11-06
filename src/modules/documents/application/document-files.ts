import { R2StorageProvider } from "@/platform/providers/real";
import { DocumentObjectStore } from "../infrastructure/document-object-store";

export function configuredDocumentObjects() { return new DocumentObjectStore(new R2StorageProvider()); }
