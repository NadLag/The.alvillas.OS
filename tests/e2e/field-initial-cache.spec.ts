import { expect, test } from "@playwright/test";
import { openFieldFixture } from "./support/field-fixture";

declare global {
  interface Window {
    initialFieldWaitingReads:()=>number;
    releaseInitialFieldControl:()=>void;
  }
}

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
test("first controller prepares the actual assigned job after initial worker installation deferred its pull", async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated local PostgreSQL required"); test.setTimeout(180000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const fixture=await openFieldFixture(page,info,"en"),origin=new URL(page.url()).origin;
  const context=await browser.newContext({baseURL:origin,storageState:await page.context().storageState(),serviceWorkers:"allow"});
  try{
    await context.addInitScript(()=>{
      const container=navigator.serviceWorker,register=container.register.bind(container);
      const originalController=Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype,"controller")!.get!.bind(container);
      let released=false,waitingReads=0,registered!:()=>void;
      const registrationReady=new Promise<void>(resolve=>registered=resolve),send=window.fetch.bind(window);
      Object.defineProperty(container,"controller",{get:()=>released?originalController() as ServiceWorker|null:null});
      container.addEventListener("controllerchange",event=>{if(!released)event.stopImmediatePropagation()},true);
      container.register=async(...args:Parameters<ServiceWorkerContainer["register"]>)=>{
        const registration=await register(...args);
        const value=new Proxy(registration,{get(target,key){
          if(key==="waiting"&&!released){waitingReads++;return target.installing??target.waiting??target.active}
          const item=Reflect.get(target,key,target) as unknown;return typeof item==="function"?item.bind(target) as unknown:item;
        }});
        registered();return value;
      };
      window.fetch=(input,init)=>{
        const url=new URL(input instanceof Request?input.url:String(input),location.href);
        return url.pathname==="/api/auth/session"?registrationReady.then(()=>send(input,init)):send(input,init);
      };
      Object.assign(window,{initialFieldWaitingReads:()=>waitingReads,releaseInitialFieldControl:()=>{
        released=true;container.dispatchEvent(new Event("controllerchange"));
      }});
    });
    const fresh=await context.newPage();
    await fresh.goto(`/en/app/field/${fixture.taskId}`);
    await expect.poll(()=>fresh.evaluate(()=>window.initialFieldWaitingReads())).toBeGreaterThanOrEqual(2);
    await expect(fresh.getByTestId("field-cash-amount")).toHaveCount(0);
    await fresh.evaluate(()=>window.releaseInitialFieldControl());
    await expect(fresh.getByTestId("field-cash-amount")).toBeEnabled();
    await expect(fresh.getByTestId("field-cache-status")).not.toContainText("Preparing");
  }finally{await context.close();await fixture.db.$disconnect()}
});
