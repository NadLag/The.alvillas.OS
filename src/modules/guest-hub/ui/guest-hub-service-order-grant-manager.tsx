"use client";

import type { ComponentProps } from "react";
import { GuestHubFormGrantManager } from "./guest-hub-form-grant-manager";

const definition = { messages: "GuestServiceOrderManagement", path: "service-orders/grant/",
  noncePrefix: "alvillas:guest-service-orders-grant:", testId: "guest-service-orders-grant" } as const;

export function GuestHubServiceOrderGrantManager(props: Omit<ComponentProps<typeof GuestHubFormGrantManager>, "definition">) {
  return <GuestHubFormGrantManager {...props} definition={definition} />;
}
