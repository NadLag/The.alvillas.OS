import { expect, type Page, type Response } from "@playwright/test";
import { varianceCenterInputSchema, type VarianceCenterFilter, type VarianceCenterProvider } from "@/modules/finance/domain/variance-center";

export function centerResponse(response: Response, filter: Partial<VarianceCenterFilter>) {
  if (!response.url().endsWith("/api/finance/variance-center/read")) return false;
  try {
    const raw: unknown = response.request().postDataJSON(), parsed = varianceCenterInputSchema.safeParse(raw);
    return parsed.success && Object.entries(filter).every(([key, value]) => parsed.data[key as keyof VarianceCenterFilter] === value);
  } catch { return false; }
}
export async function chooseCenterProvider(page: Page, provider: VarianceCenterProvider) {
  const loaded = page.waitForResponse(response => centerResponse(response, { provider }));
  await page.getByTestId("variance-center-provider").selectOption(provider); expect((await loaded).ok()).toBe(true);
  await expect(page.getByTestId("variance-center-results")).toHaveAttribute("aria-busy", "false");
}
export async function findCenterSource(page: Page, provider: VarianceCenterProvider, id: string) {
  const target = page.getByTestId("variance-center-open").and(page.locator(`a[href$="/${provider}/${id}"]`));
  for (let index = 0; index < 50; index++) {
    await expect(page.getByTestId("variance-center-results")).toHaveAttribute("aria-busy", "false");
    if (await target.count()) return target;
    await expect(page.getByTestId("variance-center-next")).toBeVisible();
    const loaded = page.waitForResponse(response => centerResponse(response, { provider }));
    await page.getByTestId("variance-center-next").click(); expect((await loaded).ok()).toBe(true);
  }
  throw Error("Original native source missing from bounded center pages");
}
