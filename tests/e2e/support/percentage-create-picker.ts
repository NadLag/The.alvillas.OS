import {expect,type Page} from "@playwright/test";
import {employeePercentageBasesSchema} from "@/modules/finance/domain/employee-percentage-workspace";

/** Real shared tenants can offer other legitimate contracts; select the exact original intent across bounded pages. */
export async function selectActualPercentageBases(page:Page,input:{referencePrefix:string;postingIds:readonly string[];assignmentId:string}){
 const response=()=>page.waitForResponse(reply=>{if(new URL(reply.url()).pathname!=="/api/finance/compensation/runs/percentage/bases"||reply.request().method()!=="POST")return false;const body=reply.request().postDataJSON() as {search?:string};return body.search===input.referencePrefix;});
 await page.getByTestId("percentage-search").fill(input.referencePrefix);let waiting=response();await page.getByTestId("percentage-search-submit").click();let reply=await waiting;expect(reply.status()).toBe(200);let result=employeePercentageBasesSchema.parse(await reply.json()),pages=0;const selected=new Set<string>();
 while(selected.size<input.postingIds.length){
  pages++;expect(pages).toBeLessThanOrEqual(100);expect(result.items.length).toBeLessThanOrEqual(25);await expect(page.getByTestId("percentage-base")).toHaveCount(result.items.length);
  for(const item of result.items){if(item.assignmentId!==input.assignmentId||!input.postingIds.includes(item.postingId))continue;const choice=page.getByTestId("percentage-choice-"+item.postingId+"-"+input.assignmentId);await expect(choice).toBeVisible();if(!selected.has(item.postingId)){await choice.focus();await choice.press("Space");await expect(choice).toBeChecked();selected.add(item.postingId);}}
  if(selected.size===input.postingIds.length)break;
  expect(result.next).toBeTruthy();const after=result.next;waiting=response();await page.getByTestId("percentage-bases-next").click();reply=await waiting;expect(reply.status()).toBe(200);expect(reply.request().postDataJSON()).toMatchObject({after});result=employeePercentageBasesSchema.parse(await reply.json());
 }
 expect(pages).toBeGreaterThan(1);expect([...selected].sort()).toEqual([...input.postingIds].sort());
}
