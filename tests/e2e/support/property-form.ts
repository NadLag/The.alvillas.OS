import { expect, type Page } from "@playwright/test";

export async function setPropertyCity(page: Page, cityName: string): Promise<string> {
  const managedCitySelect = page.getByTestId("property-city-id");

  if ((await managedCitySelect.count()) > 0) {
    await expect(managedCitySelect).toBeVisible();
    const options = await managedCitySelect.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent?.trim() ?? "",
        value: (node as HTMLOptionElement).value
      }))
    );
    const preferred =
      options.find((option) => option.label.split("/")[0]?.trim() === cityName) ??
      options.find((option) => option.label.includes(cityName)) ??
      options.find((option) => option.value);

    if (!preferred) {
      throw new Error("No managed city options are available");
    }

    await managedCitySelect.selectOption(preferred.value);
    const selectedCityName = preferred.label.split("/")[0]?.trim() ?? "";
    return selectedCityName.length > 0 ? selectedCityName : cityName;
  }

  await page.getByTestId("property-city").fill(cityName);
  return cityName;
}
