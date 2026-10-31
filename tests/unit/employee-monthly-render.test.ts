import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe,expect,it } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import ar from "../../messages/ar.json";
import { CompensationMonthlyEvidence } from "@/modules/finance/ui/compensation-monthly-evidence";

describe("actual localized monthly evidence rendering",()=>{
 it.each([
  {locale:"en" as const,messages:en,month:"January"},
  {locale:"fr" as const,messages:fr,month:"janvier"},
  {locale:"ar" as const,messages:ar,month:"يناير"}
 ])("renders a complete $locale contract month and original rates without a date-format exception",({locale,messages,month})=>{
  const coverage={month:"2026-01",eligibleDays:31,calendarDays:31,proration:"FULL_CALENDAR_MONTH_ONLY" as const,rateSelection:"DAILY_EFFECTIVE" as const,rates:[{fromOn:"2026-01-01",toOn:"2026-01-31",days:31,contractVersion:1,rate:{amount:"600.00",currency:"MAD"}}]},html=renderToStaticMarkup(createElement(NextIntlClientProvider,{locale,messages,timeZone:"UTC",children:createElement(CompensationMonthlyEvidence,{locale,coverage})}));
  expect(html).toContain(month);expect(html).toContain('data-testid="compensation-monthly-evidence"');expect(html).toContain(messages.CompensationRuns.monthlyEvidence);expect(html).toContain(messages.CompensationRuns.monthlyAppliedRates);expect(html).not.toContain("NaN");
 });
});
