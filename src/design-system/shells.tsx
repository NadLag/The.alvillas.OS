import type { ReactNode } from "react";

type ShellTone = "admin" | "manager" | "owner" | "guest" | "field";

type AudienceShellProps = {
  tone: ShellTone;
  children: ReactNode;
  className?: string;
  testId?: string;
};

type ShellHeaderProps = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  titleTestId?: string;
};

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function AudienceShell({ tone, children, className, testId }: AudienceShellProps) {
  return (
    <section className={cx("audience-shell", `audience-shell--${tone}`, className)} data-testid={testId}>
      {children}
    </section>
  );
}

export function AdminShell(props: Omit<AudienceShellProps, "tone">) {
  return <AudienceShell {...props} tone="admin" />;
}

export function ManagerShell(props: Omit<AudienceShellProps, "tone">) {
  return <AudienceShell {...props} tone="manager" />;
}

export function OwnerShell(props: Omit<AudienceShellProps, "tone">) {
  return <AudienceShell {...props} tone="owner" />;
}

export function GuestShell(props: Omit<AudienceShellProps, "tone">) {
  return <AudienceShell {...props} tone="guest" />;
}

export function FieldShell(props: Omit<AudienceShellProps, "tone">) {
  return <AudienceShell {...props} tone="field" />;
}

export function ShellHeader({ eyebrow, title, subtitle, actions, titleTestId }: ShellHeaderProps) {
  return (
    <header className="resource-header shell-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 data-testid={titleTestId}>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="app-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  children,
  testId,
  tone = "quiet"
}: {
  children: ReactNode;
  testId?: string;
  tone?: "quiet" | "motif";
}) {
  return (
    <div className={cx("empty-state-panel", tone === "motif" && "empty-state-panel--motif")} data-testid={testId}>
      <p className="empty-state">{children}</p>
    </div>
  );
}

export function SkeletonBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-block" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <span className="skeleton-line" key={index} />
      ))}
    </div>
  );
}

export function StatusBadge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return <span className={cx("status-badge", `status-badge--${tone}`)}>{children}</span>;
}
