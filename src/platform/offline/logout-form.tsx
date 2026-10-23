"use client";

export function LogoutForm({ action, label }: { action: () => Promise<void>; label: string }) {
  return <form action={async () => {
    // Signing out must still revoke the server session if browser storage is unavailable.
    await import("./field-queue").then(module => module.wipeFieldData()).catch(() => undefined);
    await action();
  }}>
    <button className="secondary-button" data-testid="logout-button" type="submit">{label}</button>
  </form>;
}
