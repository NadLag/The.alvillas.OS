import type { NextRequest } from "next/server";
import { compensationHttp } from "@/modules/finance/ui/compensation-http";
import { postEmployeeCompensationSettlement } from "@/modules/finance/application/employee-compensation-settlement";
import { employeeCompensationSettlementFormInput } from "@/modules/finance/domain/employee-compensation-settlement";
export const runtime="nodejs";
export async function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>{const {paidLocal,occurrence,calendarRuleId,calendarRuleVersion,...payment}=employeeCompensationSettlementFormInput.parse(input);return postEmployeeCompensationSettlement(actor,payment,{requestId,calendar:{id:calendarRuleId,version:calendarRuleVersion,local:paidLocal,occurrence}});},{json:true,maxBytes:8192,feature:"employee-compensation-payment-local"});}
