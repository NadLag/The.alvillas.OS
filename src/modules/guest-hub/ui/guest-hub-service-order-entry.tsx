"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { localizedText } from "@/i18n/content";
import { formatCurrencyAmount, formatNumber } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { clearCommandNonce, readCommandNonce, writeCommandNonce } from "@/platform/http/command-nonce";
import { GroceryItems, GroceryItemsEditor, groceryOrderItems, type GroceryItemForm } from "@/platform/services/grocery-items";
import { emptyTransferForm, TransferDetails, TransferRequestFields } from "@/platform/services/transfer-details";
import { guestServiceOfferPageSchema, guestServiceOrderDraftSchema, guestServiceOrderPublicReviewSchema,
  guestServiceOrderReceiptSchema, guestServiceOrderRecoveryResponseSchema, type GuestChefMenu } from "@/platform/services/guest-service-order-contracts";
import { GuestHubBrowserError, guestHubRequest } from "./guest-hub-browser";
import { guestHubServiceCategories } from "../domain/guest-hub-service-order-policy";

type Offers = z.infer<typeof guestServiceOfferPageSchema>;
type Review = z.infer<typeof guestServiceOrderPublicReviewSchema>;
type Draft = z.infer<typeof guestServiceOrderDraftSchema>;
type Receipt = z.infer<typeof guestServiceOrderReceiptSchema>;

function GuestChefMenuDetails({ menu, locale }: { menu: GuestChefMenu; locale: AppLocale }) {
  const t = useTranslations("GuestServiceOrders.chefMenu");
  const lists = new Intl.ListFormat(locale);
  return <div data-testid="guest-chef-menu">
    <h4>{t("title")}</h4>
    <dl>
      <dt>{t("servingsPerUnit")}</dt><dd>{formatNumber(locale, String(menu.servingsPerUnit))}</dd>
      <dt>{t("ingredients")}</dt><dd dir="auto">{lists.format(menu.ingredients.map(text => localizedText(text, locale)))}</dd>
      {menu.allergens.length > 0 && <>
        <dt>{t("allergens")}</dt><dd dir="auto">{lists.format(menu.allergens.map(text => localizedText(text, locale)))}</dd>
      </>}
    </dl>
  </div>;
}

export function GuestHubServiceOrderEntry({ linkId, locale, checkIn, checkOut, timezone }: {
  linkId: string; locale: AppLocale; checkIn: string; checkOut: string; timezone: string;
}) {
  const t = useTranslations("GuestServiceOrders"), common = useTranslations("GuestAccess");
  const nonceKey = `alvillas:guest-service-order:${linkId}`;
  const [pending, setPending] = useState<string | null>(() => readCommandNonce(nonceKey));
  const [offers, setOffers] = useState<Offers | null>(null);
  const [selectedServiceKey, setSelectedServiceKey] = useState("");
  const [groceryItems, setGroceryItems] = useState<GroceryItemForm[]>([]);
  const [transfer, setTransfer] = useState(emptyTransferForm);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [review, setReview] = useState<{ draft: Draft; quote: Review } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<GuestHubBrowserError["state"] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const selectedOffer = offers?.items.find(offer => offer.key === selectedServiceKey) ?? offers?.items[0];
  useEffect(() => () => { controller.current?.abort(); }, []);

  function run(work: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    setNotice(null);
    void work(request.signal).catch((failure: unknown) => {
      if (request.signal.aborted) return;
      const state = failure instanceof GuestHubBrowserError ? failure.state : "unavailable";
      setError(state);
      if (state === "link_unavailable" || state === "forbidden") {
        setOffers(null); setSelectedServiceKey(""); setGroceryItems([]); setTransfer(emptyTransferForm()); setEditing(null); setReview(null); setReceipt(null);
      }
    }).finally(() => {
      if (!request.signal.aborted) { controller.current = null; setBusy(false); }
    });
  }

  const endpoint = `links/${linkId}/service-orders/`;
  function load(after?: string) {
    run(async signal => {
      const page = guestServiceOfferPageSchema.parse(await guestHubRequest(`${endpoint}view`, after ? { after } : {}, signal));
      setOffers(previous => ({ items: after ? [...(previous?.items ?? []), ...page.items] : page.items, next: page.next }));
    });
  }

  function quote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    run(async signal => {
      const serviceDate = fields.get("serviceDate");
      const draft = guestServiceOrderDraftSchema.safeParse({ serviceKey: fields.get("serviceKey"), serviceDate,
        lastServiceDate: selectedOffer?.transfer ? serviceDate : fields.get("lastServiceDate"),
        quantity: Number(fields.get("quantity")), guests: Number(fields.get("guests")),
        ...(selectedOffer?.grocery ? { groceryItems: groceryOrderItems(groceryItems) } : {}),
        ...(selectedOffer?.transfer ? { transfer } : {}),
        locale, idempotencyKey: crypto.randomUUID() });
      if (!draft.success) throw new GuestHubBrowserError("validation");
      const result = guestServiceOrderPublicReviewSchema.parse(await guestHubRequest(`${endpoint}review`, draft.data, signal));
      setReview({ draft: draft.data, quote: result });
      setReceipt(null);
    });
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || pending) return;
    const checked = review;
    run(async signal => {
      const nonce = checked.draft.idempotencyKey;
      writeCommandNonce(nonceKey, nonce);
      if (readCommandNonce(nonceKey) !== nonce) throw new GuestHubBrowserError("unavailable");
      setPending(nonce);
      setGroceryItems([]);
      setTransfer(emptyTransferForm());
      setEditing(null);
      setReview(null);
      const result = guestServiceOrderReceiptSchema.parse(await guestHubRequest(`${endpoint}admit`, {
        ...checked.draft, acknowledged: true, reviewFingerprint: checked.quote.reviewFingerprint
      }, signal));
      if (result.idempotencyKey !== nonce) throw new GuestHubBrowserError("uncertain");
      clearCommandNonce(nonceKey, nonce);
      setPending(null);
      setReceipt(result);
    });
  }

  function recover() {
    if (!pending) return;
    run(async signal => {
      const result = guestServiceOrderRecoveryResponseSchema.parse(await guestHubRequest(`${endpoint}recover`, { idempotencyKey: pending }, signal));
      if (result.idempotencyKey !== pending) throw new GuestHubBrowserError("uncertain");
      clearCommandNonce(nonceKey, pending);
      setPending(null);
      if (result.recorded) setReceipt(result);
      else setNotice(t("unrecorded"));
    });
  }

  return <section className="resource-form" aria-labelledby="guest-services-title" aria-busy={busy} data-testid="guest-service-order-entry">
    <h3 id="guest-services-title">{t("title")}</h3>
    {busy && <p role="status">{t("loading")}</p>}
    {error && <p role="alert">{common(`states.${error}`)}</p>}
    {notice && <p role="status">{notice}</p>}
    {pending && <div className="form-actions">
      <p>{t("pending")}</p><button type="button" className="secondary-button" disabled={busy} onClick={recover}>{t("recover")}</button>
    </div>}
    {receipt && <div role="status" data-testid="guest-service-order-receipt">
      <p>{t("received")}</p><p>{t(`orderState.${receipt.state}`)}</p>
      {receipt.totalAmount !== null && <p>{formatCurrencyAmount(locale, receipt.totalAmount, receipt.currency)}</p>}
    </div>}
    {!offers && !pending && <button type="button" className="secondary-button" disabled={busy} onClick={() => load()}>{t("browse")}</button>}
    {offers && offers.items.length === 0 && <p role="status">{t("empty")}</p>}
    {offers && offers.items.length > 0 && !pending && !review && <form className="resource-form" onSubmit={quote}>
      <div className="field">
        <label htmlFor="guest-service-order-selection">{t("service")}</label>
        <select id="guest-service-order-selection" name="serviceKey" value={selectedOffer?.key ?? ""}
          onChange={event => { setSelectedServiceKey(event.target.value); setGroceryItems([]); setTransfer(emptyTransferForm()); }} required disabled={busy}>
          {offers.items.filter(offer => !offer.category).map(offer => <option key={offer.key} value={offer.key}>{localizedText(offer.name, locale)}</option>)}
          {guestHubServiceCategories.map(category => {
            const matching = offers.items.filter(offer => offer.category === category);
            return matching.length > 0 && <optgroup key={category} label={t(`category.${category}`)}>
              {matching.map(offer => <option key={offer.key} value={offer.key}>{localizedText(offer.name, locale)}</option>)}
            </optgroup>;
          })}
        </select>
      </div>
      {selectedOffer?.description && <p dir="auto">{localizedText(selectedOffer.description, locale)}</p>}
      {selectedOffer?.chefMenu && <GuestChefMenuDetails menu={selectedOffer.chefMenu} locale={locale} />}
      {selectedOffer?.grocery && <fieldset disabled={busy}>
        <GroceryItemsEditor value={groceryItems} onChange={setGroceryItems} />
      </fieldset>}
      {selectedOffer?.transfer && <fieldset disabled={busy}>
        <TransferRequestFields value={transfer} onChange={setTransfer} />
      </fieldset>}
      <div className="form-grid two">
        <label className="field"><span>{t(selectedOffer?.transfer ? "pickupDate" : "serviceDate")}</span><input type="date" name="serviceDate" required min={checkIn} max={checkOut} defaultValue={editing?.serviceDate ?? checkIn} disabled={busy} /></label>
        {!selectedOffer?.transfer && <label className="field"><span>{t("lastServiceDate")}</span><input type="date" name="lastServiceDate" required min={checkIn} max={checkOut} defaultValue={editing?.lastServiceDate ?? checkIn} disabled={busy} /></label>}
        <label className="field"><span>{t("quantity")}</span><input name="quantity" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={editing?.quantity ?? 1} required disabled={busy} /></label>
        <label className="field"><span>{t("guests")}</span><input name="guests" type="number" min="1" step="1" defaultValue={editing?.guests ?? 1} required disabled={busy} /></label>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={busy || (selectedOffer?.grocery && groceryItems.length === 0)}>{t("review")}</button>
        {offers.next && <button type="button" className="secondary-button" onClick={() => load(offers.next ?? undefined)} disabled={busy}>{t("more")}</button>}
      </div>
    </form>}
    {review && <form className="resource-form" onSubmit={send} data-testid="guest-service-order-review">
      <h4>{localizedText(review.quote.title, locale)}</h4>
      {review.quote.category && <p>{t(`category.${review.quote.category}`)}</p>}
      <p>{review.quote.totalAmount === null ? t("quoteRequired") : formatCurrencyAmount(locale, review.quote.totalAmount, review.quote.currency)}</p>
      {review.quote.chefMenu && <GuestChefMenuDetails menu={review.quote.chefMenu} locale={locale} />}
      {review.quote.selection.groceryItems && <GroceryItems locale={locale} items={review.quote.selection.groceryItems} />}
      {review.quote.selection.transfer && <TransferDetails locale={locale} transfer={review.quote.selection.transfer}
        date={review.quote.selection.serviceDate} guests={review.quote.selection.guests} timezone={timezone} headingLevel={4} showCashHelp={false} />}
      <h5>{review.quote.notice.title}</h5>
      {review.quote.notice.paragraphs.map((paragraph, index) => <p key={index} dir="auto">{paragraph}</p>)}
      <label><input type="checkbox" required disabled={busy} /> {t("acknowledge")}</label>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>{t("submit")}</button>
        <button type="button" className="secondary-button" onClick={() => { setEditing(review.draft); setReview(null); }} disabled={busy}>{t("edit")}</button></div>
    </form>}
  </section>;
}
