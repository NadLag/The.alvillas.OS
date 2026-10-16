import type { WhatsappSource } from "./whatsapp";

export function whatsappComposerPath(locale: string, source: WhatsappSource): string {
  return `/${locale}/app/notifications/whatsapp?${new URLSearchParams({ type: source.type, id: source.id })}`;
}
