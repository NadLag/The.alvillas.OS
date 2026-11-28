"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import type { GuestHubLinkDeliveryChannel } from "@/platform/config/guest-hub-link-delivery-policy";
import { guestHubLinkDeliveryReceiptSchema, guestHubLinkDeliveryReviewSchema } from "../domain/guest-hub-link-delivery";
import { guestHubRequest } from "./guest-hub-browser";

export function GuestHubLinkDelivery({ scope, linkId, channels, onClose }: {
  scope: string; linkId: string; channels: readonly GuestHubLinkDeliveryChannel[]; onClose: () => void;
}) {
  const t = useTranslations("GuestLinkDelivery");
  const [review, setReview] = useState<z.infer<typeof guestHubLinkDeliveryReviewSchema> | null>(null);
  const [receipt, setReceipt] = useState<z.infer<typeof guestHubLinkDeliveryReceiptSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);

  function run(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setFailed(false);
    void action(request.signal).catch(() => { if (!request.signal.aborted) setFailed(true); }).finally(() => {
      if (!request.signal.aborted) { controller.current = null; setBusy(false); }
    });
  }

  function prepare(channel: GuestHubLinkDeliveryChannel) {
    run(async signal => {
      setReceipt(null);
      setReview(null);
      const result = guestHubLinkDeliveryReviewSchema.parse(await guestHubRequest("delivery/review", { linkId, channel }, signal, scope));
      if (result.linkId !== linkId || result.channel !== channel) throw Error("Invalid link delivery review");
      if (!signal.aborted) setReview(result);
    });
  }

  function confirm() {
    if (!review) return;
    const checked = review;
    run(async signal => {
      const result = guestHubLinkDeliveryReceiptSchema.parse(await guestHubRequest("delivery/admit", {
        linkId, channel: checked.channel, reviewFingerprint: checked.reviewFingerprint
      }, signal, scope));
      if (result.linkId !== linkId || result.channel !== checked.channel) throw Error("Invalid link delivery receipt");
      if (!signal.aborted) { setReview(null); setReceipt(result); }
    });
  }

  return <section className="resource-form" aria-busy={busy} aria-labelledby="guest-link-delivery-title" data-testid="guest-link-delivery-panel">
    <h3 id="guest-link-delivery-title">{t("title")}</h3>
    {failed && <p role="alert">{t("failed")}</p>}
    <div className="form-actions">{channels.map(channel => <button type="button" className="secondary-button" key={channel}
      disabled={busy} onClick={() => prepare(channel)}>{t(channel === "EMAIL" ? "email" : "whatsapp")}</button>)}</div>
    {review && <div className="form-actions">
      <p dir="auto">{t("recipient", { recipient: review.recipientLabel })}</p>
      <button className="primary-button" type="button" disabled={busy} onClick={confirm}>{t(review.channel === "EMAIL" ? "sendEmail" : "prepareWhatsapp")}</button>
    </div>}
    {receipt?.channel === "EMAIL" && <p role="status">{t("queued")}</p>}
    {receipt?.channel === "WHATSAPP" && <a className="primary-button" href={receipt.draftUrl} target="_blank" rel="noopener noreferrer">{t("openWhatsapp")}</a>}
    <button type="button" className="quiet-button" onClick={onClose}>{t("close")}</button>
  </section>;
}
