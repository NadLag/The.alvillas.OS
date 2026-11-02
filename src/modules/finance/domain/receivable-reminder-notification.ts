import type {AuthContext,Resource} from "@/platform/authz/authorize";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";

/** A financial reminder never turns an operational inbox into financial access. */
export function canReadReceivableReminder(ctx:AuthContext,target:Resource,now:Date){
 if(target.type!=="receivable"||target.organizationId!==ctx.organizationId||target.dataClass!=="financial")return false;
 return["receivable","financial_transaction","staff_compensation"].every(type=>authorizeOrganizationSource(ctx,"view",{type,organizationId:target.organizationId,id:target.organizationId,dataClass:"financial"},now));
}
