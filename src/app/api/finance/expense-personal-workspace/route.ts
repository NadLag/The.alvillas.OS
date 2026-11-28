import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {readExpensePersonalWorkspace} from "@/modules/finance/application/expense-personal-settlement";
export function POST(request:NextRequest){return compensationHttp(request,(actor,input,requestId)=>readExpensePersonalWorkspace(actor,input,{requestId}),{json:true,maxBytes:2048,rejectQuery:true,feature:"expense-personal-workspace"});}
