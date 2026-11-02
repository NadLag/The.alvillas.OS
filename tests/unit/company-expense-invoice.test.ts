import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {companyExpenseInvoiceCommandSchema} from "@/modules/finance/domain/company-expense-invoice";
const command={operation:"ATTACH",companyExpenseId:randomUUID(),invoiceLineId:randomUUID(),expectedSourceVersion:0,expectedPlanVersion:1,reason:"Associate the actual original invoice source"};
describe("company invoice source association",()=>{
 it("retains canonical source identity and explicit optimistic history versions",()=>{expect(companyExpenseInvoiceCommandSchema.parse(command)).toEqual(command);expect(companyExpenseInvoiceCommandSchema.parse({...command,operation:"RELEASE",expectedSourceVersion:1}).operation).toBe("RELEASE");});
 it.each([{amount:"0.09"},{currency:"MAD"},{propertyId:randomUUID()},{transactionId:randomUUID()},{paidAmount:"0.09"},{autoPay:true}])("refuses invented financial source attributes %j",extra=>{expect(companyExpenseInvoiceCommandSchema.safeParse({...command,...extra}).success).toBe(false);});
 it("refuses invalid history versions and a missing actual source",()=>{for(const value of[{...command,expectedSourceVersion:-1},{...command,expectedPlanVersion:0},{...command,invoiceLineId:"scheduled-plan"}])expect(companyExpenseInvoiceCommandSchema.safeParse(value).success).toBe(false);});
});
