import { NextResponse,type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession,type FinanceActorContext } from "../application/finance-access";
import { EmployeeCompensationAccessError,EmployeeCompensationSourceUnavailableError,EmployeeCompensationBasisError } from "../domain/employee-compensation";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { ExpensePolicyUnavailableError } from "../application/expense-submission-policy";
import { EmployeeCompensationRecognitionSourceError } from "../domain/employee-compensation-recognition";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { PaymentAccountChoiceAccessError } from "../domain/payment-account-choices";
import { ExpenseAccessError } from "../application/expense-service";
import { EmployeeWorkTimeAccessError,EmployeeWorkTimeConflictError,EmployeeWorkTimePolicyError,EmployeeWorkTimeSourceError } from "../domain/employee-work-time";
import {ReceivableAccessError,ReceivablePolicyError} from "../domain/receivable";
import {ReceivableAssignmentSourceError,ReceivableAssignmentConflictError} from "../domain/receivable-assignment";
import {ReceivableCollectionSourceError,ReceivableCollectionConflictError} from "../domain/receivable-collection";
import {ReceivableAgingSourceError,ReceivableAgingChangedError} from "../domain/receivable-aging";
import {ReceivableExportRateLimitError} from "../domain/receivable-export";
import {RecurringExpenseAccessError,RecurringExpenseConfigurationError} from "../domain/recurring-expense";
import {RecurringExpenseChangedError} from "../domain/recurring-expense-settings";
import {CompanyExpenseAccessError,CompanyExpenseChangedError,CompanyExpenseConfigurationError} from "../domain/company-expense";
import {SupplierInvoiceAccessError,SupplierInvoiceConflictError} from "../application/supplier-invoice-access";
import {ConfigAuthorizationError,ConfigValidationError,ConfigNotFoundError} from "@/platform/config/rule-version-writer";
import {PropertyFinanceAccessError,PropertyFinanceConfigurationError,PropertyFinanceSourceChangedError} from "../domain/property-finance";
import {ServiceAllocationAccessError,ServiceAllocationConfigurationError,ServiceAllocationSourceChangedError,ServiceAllocationSourceUnavailableError} from "../domain/service-allocation";
import {GuestDepositAuthorizationError,GuestDepositConfigurationError,GuestDepositConflictError,GuestDepositSourceError} from "../domain/guest-deposit";
import {BankStatementAccessError,BankStatementConfigurationError,BankStatementConflictError,BankStatementValidationError,BankStatementStorageError} from "../domain/bank-statement";
import {BankReconciliationAccessError,BankReconciliationConflictError,BankReconciliationConfigurationError} from "../domain/bank-reconciliation";
import {ReconciliationSourceError,ReconciliationBudgetError} from "../domain/reconciliation";
import { VarianceWorkflowSourceError, VarianceWorkflowConflictError } from "../domain/variance-workflow";
import { VarianceCenterAccessError, VarianceCenterCursorError } from "../domain/variance-center";
import { TaxHookAccessError, TaxHookConfigurationError, TaxHookChangedError } from "../domain/tax-hook";
import { AccountantExportAccessError, AccountantExportConfigurationError, AccountantExportSourceError, AccountantExportChangedError, AccountantExportCapacityError, AccountantExportRateLimitError } from "../domain/accountant-export";
import { FinancialAttachmentAccessError, FinancialAttachmentConfigurationError, FinancialAttachmentSourceError, FinancialAttachmentConflictError,
  FinancialAttachmentValidationError, FinancialAttachmentStorageError, FinancialAttachmentRateLimitError } from "../domain/financial-attachment";

const headers={"Cache-Control":"private, no-store",Vary:"Cookie, Origin"};
const failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});

/** One session, origin, size and private-error boundary for compensation reads and commands. */
export async function compensationHttp<T extends Promise<unknown>>(request:NextRequest,work:(actor:FinanceActorContext,input:unknown,requestId:string)=>T,options:{json?:boolean;maxBytes?:number;feature:string;status?:200|202;rejectQuery?:boolean;respond?:(value:Awaited<T>)=>Response}){
  const requestId=crypto.randomUUID();
  try{
    const actor=await financeActorContextFromSession(await auth());
    if(!actor)return failure("unauthorized",401);
    if(options.rejectQuery&&request.nextUrl.search)return failure("validation",400);
    let input:unknown;
    if(options.json){
      if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);
      try{input=await readBoundedJsonRequest(request,options.maxBytes??65536);}catch{return failure("validation",400);}
    }
    const value=await work(actor,input,requestId),response=options.respond?options.respond(value):NextResponse.json(value,{headers,status:options.status??200});
    for(const[key,value]of Object.entries(headers))response.headers.set(key,value);return response;
  }catch(error){
    if(error instanceof FinancialAttachmentAccessError)return failure("forbidden",403);
    if(error instanceof FinancialAttachmentConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof FinancialAttachmentSourceError)return failure("source_unavailable",409);
    if(error instanceof FinancialAttachmentConflictError)return failure("conflict",409);
    if(error instanceof FinancialAttachmentValidationError)return failure("validation",400);
    if(error instanceof FinancialAttachmentStorageError)return failure("storage_unavailable",503);
    if(error instanceof FinancialAttachmentRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
    if(error instanceof AccountantExportAccessError)return failure("forbidden",403);
    if(error instanceof AccountantExportConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof AccountantExportSourceError)return failure("source_unavailable",409);
    if(error instanceof AccountantExportChangedError)return failure("conflict",409);
    if(error instanceof AccountantExportCapacityError)return failure("capacity_exceeded",409);
    if(error instanceof AccountantExportRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
    if(error instanceof TaxHookAccessError)return failure("forbidden",403);
    if(error instanceof TaxHookConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof TaxHookChangedError)return failure("conflict",409);
    if(error instanceof VarianceCenterAccessError)return failure("forbidden",403);
    if(error instanceof VarianceCenterCursorError)return failure("validation",400);
    if(error instanceof VarianceWorkflowSourceError)return failure("forbidden",403);
    if(error instanceof VarianceWorkflowConflictError)return failure("conflict",409);
    if(error instanceof BankReconciliationAccessError)return failure("forbidden",403);
    if(error instanceof BankReconciliationConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof BankReconciliationConflictError)return failure("conflict",409);
    if(error instanceof ReconciliationSourceError||error instanceof ReconciliationBudgetError)return failure("source_unavailable",409);
    if(error instanceof BankStatementAccessError)return failure("forbidden",403);
    if(error instanceof BankStatementConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof BankStatementConflictError)return failure("conflict",409);
    if(error instanceof BankStatementValidationError)return failure("validation",400);
    if(error instanceof BankStatementStorageError)return failure("storage_unavailable",503);
    if(error instanceof GuestDepositAuthorizationError)return failure("forbidden",403);
    if(error instanceof GuestDepositConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof GuestDepositConflictError)return failure("conflict",409);
    if(error instanceof GuestDepositSourceError)return failure("source_unavailable",409);
    if(error instanceof ServiceAllocationAccessError)return failure("forbidden",403);
    if(error instanceof ServiceAllocationConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof ServiceAllocationSourceChangedError)return failure("conflict",409);
    if(error instanceof ServiceAllocationSourceUnavailableError)return failure("source_unavailable",409);
    if(error instanceof PropertyFinanceAccessError)return failure("forbidden",403);
    if(error instanceof PropertyFinanceConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof PropertyFinanceSourceChangedError)return failure("conflict",409);
    if(error instanceof CompanyExpenseAccessError||error instanceof SupplierInvoiceAccessError||error instanceof ConfigAuthorizationError)return failure("forbidden",403);
    if(error instanceof ConfigValidationError)return failure("validation",400);
    if(error instanceof ConfigNotFoundError)return failure("conflict",409);
    if(error instanceof CompanyExpenseChangedError||error instanceof SupplierInvoiceConflictError)return failure("conflict",409);
    if(error instanceof CompanyExpenseConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof ZodError||error instanceof EmployeeCompensationBasisError)return failure("validation",400);
    if(error instanceof RecurringExpenseAccessError)return failure("forbidden",403);
    if(error instanceof RecurringExpenseConfigurationError)return failure("configuration_unavailable",409);
    if(error instanceof RecurringExpenseChangedError)return failure("conflict",409);
    if(error instanceof ReceivableAccessError)return failure("forbidden",403);
    if(error instanceof ReceivablePolicyError)return failure("configuration_unavailable",409);
    if(error instanceof ReceivableExportRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
    if(error instanceof ReceivableAssignmentSourceError)return failure("source_unavailable",409);
    if(error instanceof ReceivableAssignmentConflictError)return failure("conflict",409);
    if(error instanceof ReceivableCollectionSourceError)return failure("source_unavailable",409);
    if(error instanceof ReceivableCollectionConflictError)return failure("conflict",409);
    if(error instanceof ReceivableAgingSourceError)return failure("source_unavailable",409);
    if(error instanceof ReceivableAgingChangedError)return failure("conflict",409);
    if(error instanceof EmployeeCompensationAccessError||error instanceof EmployeeCompensationRunAccessError||error instanceof PaymentAccountChoiceAccessError||error instanceof ExpenseAccessError||error instanceof EmployeeWorkTimeAccessError)return failure("forbidden",403);
    if(error instanceof EmployeeWorkTimeConflictError)return failure("conflict",409);
    if(error instanceof EmployeeWorkTimePolicyError)return failure("configuration_unavailable",409);
    if(error instanceof EmployeeWorkTimeSourceError)return failure("source_unavailable",409);
    if(error instanceof EmployeeCompensationSourceUnavailableError||error instanceof EmployeeCompensationClaimSourceError||error instanceof EmployeeCompensationRecognitionSourceError)return failure("source_unavailable",409);
    if(error instanceof AccountingPeriodClosedError)return failure("period_closed",409);
    if(error instanceof EmployeeCompensationRunPolicyError||error instanceof ExpensePolicyUnavailableError)return failure("configuration_unavailable",409);
    if(error instanceof EmployeeCompensationRunConflictError)return failure("conflict",409);
    try{await captureException(error,{source:"api",requestId,tags:{feature:options.feature}});}catch{/* Preserve the private response if telemetry delivery fails. */}
    return failure("unavailable",503);
  }
}
