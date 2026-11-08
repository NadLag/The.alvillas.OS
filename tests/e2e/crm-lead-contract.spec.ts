import {test} from "@playwright/test";
import {nativeLeadContractBrowserFlow} from "./support/crm-contract-browser-flow";
for(const locale of["en","fr","ar"]as const)test(`Actual Lead contract recovers original signer, preparation and delivery without an Owner in ${locale}`,async({page,context},info)=>{await nativeLeadContractBrowserFlow(page,context,locale,info);});
