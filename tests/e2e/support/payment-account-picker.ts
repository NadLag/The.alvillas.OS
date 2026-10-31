import { expect,type Locator,type Page } from "@playwright/test";

/** Exercise the actual authorized search; no injected options, fixtures or API interception. */
export async function selectPaymentAccount(root:Page|Locator,testId:string,choice:string|{label:string}){
  const query=typeof choice==="string"?choice:choice.label;
  await root.getByTestId(`${testId}-query`).fill(query);
  await root.getByTestId(`${testId}-search`).click();
  const select=root.getByTestId(testId);
  await expect(select).toBeEnabled();
  if(typeof choice==="string")await expect(select.locator(`option[value="${choice}"]`)).toHaveCount(1);
  else await expect(select.getByRole("option",{name:choice.label,exact:true})).toHaveCount(1);
  await select.selectOption(choice);
  await expect(select).toBeEnabled();
  if(typeof choice==="string")await expect(select).toHaveValue(choice);
}
