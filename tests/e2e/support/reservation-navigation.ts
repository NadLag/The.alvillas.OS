import { expect, type Page } from "@playwright/test";

export async function submitReservationToOperations(page: Page, locale: string, propertyId: string, guestName: string) {
  const reservation = new URL(`/${locale}/app/reservations`, page.url());
  const operations = new URL(`/${locale}/app/operations`, reservation.origin);
  operations.searchParams.set("propertyId", propertyId);
  const [acknowledgement] = await Promise.all([
    page.waitForResponse(response => {
      const request = response.request();
      const destination = response.headers()["x-action-redirect"]?.split(";", 1)[0];
      return request.method() === "POST" && request.url() === reservation.href &&
        Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(guestName)) &&
        destination === operations.pathname + operations.search;
    }),
    page.waitForURL(operations.href, { waitUntil: "commit" }),
    page.getByTestId("reservation-submit").click()
  ]);
  expect(acknowledgement.ok()).toBe(true);
  await expect(page).toHaveURL(operations.href);
}
