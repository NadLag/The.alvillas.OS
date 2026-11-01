import {expect,test} from "@playwright/test";
import {utcDateTimeLocalValue} from "./support/date-time-local";
test.use({locale:"ar-MA",timezoneId:"America/Denver"});
test("Native datetime inputs retain exact seconds and milliseconds at minute and day boundaries",async({page})=>{
 await page.setContent('<html lang="ar" dir="rtl"><body><label>Clock<input type="datetime-local" step="0.001" dir="ltr"></label></body></html>');
 const clock=page.getByLabel("Clock");
 for(const iso of["2026-10-31T12:34:00.000Z","2026-10-31T12:00:00.000Z","2026-11-01T00:00:00.000Z","2026-10-31T12:34:09.000Z","2026-10-31T12:34:00.001Z","2026-10-31T12:34:09.010Z","2026-10-31T12:34:00.100Z","2026-10-31T12:34:09.120Z","2026-10-31T12:34:09.999Z"]){
  const expected=new Date(iso),value=utcDateTimeLocalValue(expected);await clock.fill(value);await expect(clock).toHaveValue(value);expect(await clock.evaluate((input:HTMLInputElement)=>input.valueAsNumber)).toBe(expected.getTime());expect(new Date((await clock.inputValue())+"Z").toISOString()).toBe(iso);
 }
});
