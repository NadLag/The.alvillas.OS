import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {getRecurringExpenseSettings,saveRecurringExpenseSettings} from "@/modules/finance/application/recurring-expense-settings-service";
export const runtime="nodejs";
type Context={params:Promise<{propertyId:string}>};
export function GET(request:NextRequest,context:Context){return compensationHttp(request,async(actor,_input,requestId)=>getRecurringExpenseSettings(actor,(await context.params).propertyId,{requestId}),{rejectQuery:true,feature:"recurring-expenses"});}
export function POST(request:NextRequest,context:Context){return compensationHttp(request,async(actor,input,requestId)=>saveRecurringExpenseSettings(actor,(await context.params).propertyId,input,{requestId}),{json:true,rejectQuery:true,feature:"recurring-expenses"});}
