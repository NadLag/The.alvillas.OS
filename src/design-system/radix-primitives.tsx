"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as Toast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { cloneElement, isValidElement, useState } from "react";
import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { cx } from "@/design-system/shells";

export function DesignTabs({
  defaultValue,
  items,
  label
}: {
  defaultValue: string;
  label: string;
  items: Array<{ value: string; label: string; content: ReactNode }>;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <Tabs.Root className="dsn-tabs" onValueChange={setValue} value={value}>
      <Tabs.List aria-label={label} className="dsn-tabs-list">
        {items.map((item) => (
          <Tabs.Trigger className="dsn-tab-trigger" key={item.value} onClick={() => setValue(item.value)} value={item.value}>
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {items.map((item) => (
        <Tabs.Content className="dsn-tab-content" key={item.value} value={item.value}>
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

export function DesignDialog({
  trigger,
  title,
  description,
  children,
  closeLabel,
  open: controlledOpen,
  onOpenChange
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  closeLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };
  const triggerNode = isValidElement<DialogTriggerProps>(trigger)
    ? cloneElement(trigger, {
        onClick: composeOpenHandler(trigger, () => setOpen(true))
      })
    : trigger;

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger asChild>{triggerNode}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dsn-dialog-overlay" />
        <Dialog.Content className="dsn-dialog-content">
          <div className="dsn-dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close aria-label={closeLabel} className="icon-button" type="button">
              <X aria-hidden="true" size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type DialogTriggerProps = {
  onClick?: MouseEventHandler<HTMLElement>;
};

function composeOpenHandler(
  trigger: ReactElement<DialogTriggerProps>,
  openDialog: () => void
): MouseEventHandler<HTMLElement> {
  return (event) => {
    trigger.props.onClick?.(event);

    if (!event.defaultPrevented) {
      openDialog();
    }
  };
}

export function ToastRegion({
  open,
  title,
  description,
  onOpenChange
}: {
  open: boolean;
  title: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Toast.Provider swipeDirection="right">
      <Toast.Root className="dsn-toast" onOpenChange={onOpenChange} open={open}>
        <Toast.Title>{title}</Toast.Title>
        {description ? <Toast.Description>{description}</Toast.Description> : null}
      </Toast.Root>
      <Toast.Viewport className={cx("dsn-toast-viewport")} />
    </Toast.Provider>
  );
}
