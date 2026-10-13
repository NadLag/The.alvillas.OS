"use client";

import { Bell, Check, DoorOpen } from "lucide-react";
import { useState } from "react";

import { DesignDialog, DesignTabs, ToastRegion } from "@/design-system/radix-primitives";
import {
  AdminShell,
  EmptyState,
  FieldShell,
  GuestShell,
  ManagerShell,
  OwnerShell,
  SkeletonBlock,
  StatusBadge
} from "@/design-system/shells";

type DesignSystemBoardLabels = {
  tabsLabel: string;
  components: string;
  shells: string;
  states: string;
  dialog: string;
  openDialog: string;
  closeDialog: string;
  toast: string;
  showToast: string;
  toastBody: string;
  empty: string;
  loading: string;
  error: string;
  shellAdmin: string;
  shellManager: string;
  shellOwner: string;
  shellGuest: string;
  shellField: string;
  fieldAction: string;
};

export function DesignSystemBoard({ labels }: { labels: DesignSystemBoardLabels }) {
  const [toastOpen, setToastOpen] = useState(false);

  return (
    <DesignTabs
      defaultValue="components"
      label={labels.tabsLabel}
      items={[
        {
          value: "components",
          label: labels.components,
          content: (
            <div className="dsn-board-grid">
              <section className="dsn-board-surface">
                <p className="panel-label">{labels.dialog}</p>
                <DesignDialog
                  closeLabel={labels.closeDialog}
                  description={labels.toastBody}
                  title={labels.dialog}
                  trigger={
                    <button className="primary-button icon-text-button" type="button">
                      <DoorOpen aria-hidden="true" size={16} />
                      <span>{labels.openDialog}</span>
                    </button>
                  }
                >
                  <EmptyState tone="motif">{labels.empty}</EmptyState>
                </DesignDialog>
              </section>
              <section className="dsn-board-surface">
                <p className="panel-label">{labels.toast}</p>
                <button className="secondary-button icon-text-button" onClick={() => setToastOpen(true)} type="button">
                  <Bell aria-hidden="true" size={16} />
                  <span>{labels.showToast}</span>
                </button>
                <ToastRegion
                  description={labels.toastBody}
                  onOpenChange={setToastOpen}
                  open={toastOpen}
                  title={labels.toast}
                />
              </section>
            </div>
          )
        },
        {
          value: "shells",
          label: labels.shells,
          content: (
            <div className="dsn-board-grid">
              <AdminShell className="dsn-board-surface">
                <p className="panel-label">{labels.shellAdmin}</p>
                <StatusBadge tone="warning">{labels.error}</StatusBadge>
              </AdminShell>
              <ManagerShell className="dsn-board-surface">
                <p className="panel-label">{labels.shellManager}</p>
                <StatusBadge>{labels.loading}</StatusBadge>
              </ManagerShell>
              <OwnerShell className="dsn-board-surface">
                <p className="panel-label">{labels.shellOwner}</p>
                <StatusBadge tone="success">{labels.toast}</StatusBadge>
              </OwnerShell>
              <GuestShell className="dsn-board-surface">
                <p className="panel-label">{labels.shellGuest}</p>
                <StatusBadge>{labels.components}</StatusBadge>
              </GuestShell>
              <FieldShell className="dsn-board-surface">
                <p className="panel-label">{labels.shellField}</p>
                <button className="primary-button icon-text-button field-complete-button" type="button">
                  <Check aria-hidden="true" size={18} />
                  <span>{labels.fieldAction}</span>
                </button>
              </FieldShell>
            </div>
          )
        },
        {
          value: "states",
          label: labels.states,
          content: (
            <div className="dsn-board-grid">
              <section className="dsn-board-surface">
                <p className="panel-label">{labels.empty}</p>
                <EmptyState tone="motif">{labels.empty}</EmptyState>
              </section>
              <section className="dsn-board-surface">
                <p className="panel-label">{labels.loading}</p>
                <SkeletonBlock />
              </section>
              <section className="dsn-board-surface">
                <p className="panel-label">{labels.error}</p>
                <p className="form-error" role="alert">
                  {labels.error}
                </p>
              </section>
            </div>
          )
        }
      ]}
    />
  );
}
