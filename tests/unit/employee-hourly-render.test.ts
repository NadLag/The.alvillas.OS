import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe,expect,it } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import ar from "../../messages/ar.json";
import { CompensationHourlyEvidence } from "@/modules/finance/ui/compensation-hourly-evidence";
describe("original actual hourly evidence rendering",()=>{
 it.each([{locale:"en" as const,messages:en},{locale:"fr" as const,messages:fr},{locale:"ar" as const,messages:ar}])("renders original $locale milliseconds and UTC rates with bounded visible segments",({locale,messages})=>{
  const rate={startsAt:"2026-10-31T10:00:00.001Z",endsAt:"2026-10-31T10:00:01.002Z",duration:{hours:"0",minutes:"0",seconds:"1.001"},contractVersion:1,rate:{amount:"18.00",currency:"MAD"}},coverage={evidenceVersion:1,validatedAt:"2026-10-31T11:00:00.003Z",milliseconds:"26026",duration:{hours:"0",minutes:"0",seconds:"26.026"},rates:Array.from({length:26},(_,i)=>({...rate,startsAt:new Date(new Date(rate.startsAt).getTime()+i*2000).toISOString(),endsAt:new Date(new Date(rate.endsAt).getTime()+i*2000).toISOString()}))};
  const html=renderToStaticMarkup(createElement(NextIntlClientProvider,{locale,messages,timeZone:"UTC",children:createElement(CompensationHourlyEvidence,{locale,coverage})}));
  expect(html).toContain(messages.CompensationRuns.hourlyEvidence);expect(html).toContain(messages.CompensationRuns.hourlyRounding);expect(html).toContain(messages.CompensationRuns.hourlyNextRates);expect(html.match(/<li>/gu)).toHaveLength(25);expect(html).toContain('dateTime="2026-10-31T10:00:00.001Z"');expect(html).not.toContain("NaN");
 });
});
