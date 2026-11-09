import {test} from "@playwright/test";
import {nativeLeadConversionBrowserFlow} from "./support/crm-conversion-browser-flow";
for(const mode of["CREATE","LINK"]as const)for(const locale of["en","fr","ar"]as const)test(`Actual reviewed ${mode} conversion retains native signed Lead and original Owner in ${locale}`,async({page,context},info)=>{await nativeLeadConversionBrowserFlow(page,context,locale,info,mode);});
