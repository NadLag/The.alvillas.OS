import type { ReactNode } from "react";
import { auth } from "@/platform/auth/session";
import { NotificationCenter } from "@/platform/notifications/notification-center";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  return <>
    {session?.user?.id && !session.user.securitySetupRequired ? <div className="notification-toolbar"><NotificationCenter /></div> : null}
    {children}
  </>;
}
