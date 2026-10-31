import { scheduleReservationSyncs } from "@/modules/reservations/application/reservation-management-service";
import { cleanupFieldUploadParts } from "@/modules/reservations/application/field-upload-cleanup";
import { Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { readEnv } from "@/platform/env/env";
import { createInngestOutboxHandlers } from "./inngest";
import { dispatchOutboxBatch, type DispatchOutboxResult } from "./outbox-dispatcher";
import { OutboxRepository, type OutboxDatabase } from "./outbox-repository";
import { outboxDispatchEvent } from "./outbox";
import { automationEvents } from "@/platform/automation/events";
import { automationTick, enqueueAutomationEvent, executeAutomationRun } from "@/platform/automation/service";
import { executeSupplierInvoiceRecognitionReference, failSupplierInvoiceRecognitionReference, supplierInvoiceRecognitionRequested, supplierInvoiceReversalRequested } from "@/modules/finance/application/supplier-invoice-recognition-requests";
import { employeeCompensationSubmissionRequested,executeEmployeeCompensationSubmissionReference,failEmployeeCompensationSubmissionReference } from "@/modules/finance/application/employee-compensation-submission-requests";
import { employeeMonthlyRunRequested,executeEmployeeMonthlyRunReference,failEmployeeMonthlyRunReference } from "@/modules/finance/application/employee-monthly-run-requests";
import { employeeCompensationRecognitionRequested,executeEmployeeCompensationRecognitionReference,failEmployeeCompensationRecognitionReference } from "@/modules/finance/application/employee-compensation-recognition-requests";

import { scheduleDigests } from "@/platform/notifications/digest-service";
import { scheduleTeamDocumentReminders } from "@/modules/identity/application/team-documents";
import { scheduleOperationTasks,operationSchedulerProperties } from "@/modules/reservations/application/operation-automation";

export { outboxDispatchEvent };
export const outboxDispatchInput = z.object({ organizationId: z.string().uuid(), outboxEventId: z.string().uuid() }).strict();

// Cloud mode is explicit: a deployed endpoint never silently disables signatures.
export const inngest = new Inngest({ id: "alvillas-os", env: process.env.INNGEST_ENV,
  isDev: process.env.INNGEST_DEV === "1" && !["preview", "production"].includes(process.env.VERCEL_ENV ?? "") });

export async function dispatchRequestOrganization(input: unknown, db: OutboxDatabase = prisma) {
  const parsed = outboxDispatchInput.safeParse(input);
  if (!parsed.success) throw new NonRetriableError("invalid_outbox_dispatch_reference");
  const { organizationId, outboxEventId } = parsed.data;
  const event = await withTenant(db, organizationId, tx => new OutboxRepository(tx, organizationId).event(outboxEventId));
  if (!event || event.type !== outboxDispatchEvent || event.status === "FAILED") throw new NonRetriableError("outbox_dispatch_reference_denied");
  return organizationId;
}

export async function dispatchOrganization(organizationId: string, db: OutboxDatabase = prisma) {
  return dispatchOutboxBatch(db, organizationId, createInngestOutboxHandlers(readEnv(), undefined, undefined, { db }), { limit: 25 });
}

// This is infrastructure polling cadence; business schedules and push retry policy
// continue to resolve through their existing configuration/consumer paths.
export const dispatchOutbox = inngest.createFunction({ id: "dispatch-outbox", name: "ALVILLAS OS outbox dispatcher",
  // Timer events have no event.id: function-level admission deduplication would
  // suppress subsequent cron ticks. Stable Event API IDs and the database guard
  // duplicate forwarding and delivery without blocking recurring recovery.
  triggers: [{ cron: "* * * * *" }, { event: outboxDispatchEvent }], concurrency: { limit: 1 }, retries: 3
}, async ({ event, step }) => {
  const organizations = event.name === "inngest/scheduled.timer"
    ? await step.run("list-organizations", () => OutboxRepository.organizations(prisma))
    : [{ id: await step.run("validate-dispatch-reference", () => dispatchRequestOrganization(event.data)) }];
  const total: DispatchOutboxResult & { organizations: number } = { organizations: organizations.length, dispatched: 0, failed: 0, skipped: 0 };
  for (const { id } of organizations) {
    await step.run(`sync-reservation-feeds-${id}`, () => scheduleReservationSyncs(id));
    const operationProperties=await step.run(`operations-properties-${id}`,()=>operationSchedulerProperties(id));
    for(const propertyId of operationProperties)await step.run(`schedule-operations-${id}-${propertyId}`,()=>scheduleOperationTasks(id,{propertyId}));
    await step.run(`schedule-staff-documents-${id}`, () => scheduleTeamDocumentReminders(id));
    await step.run(`schedule-digests-${id}`, () => scheduleDigests(id));
    await step.run(`automation-recovery-${id}`, () => automationTick(id));
    const result = await step.run(`dispatch-${id}`, () => dispatchOrganization(id));
    total.dispatched += result.dispatched; total.failed += result.failed; total.skipped += result.skipped;
  }
  return total;
});

export async function consumeAutomationReference(input: unknown, eventType: string, db: OutboxDatabase = prisma) {
  const parsed = outboxDispatchInput.safeParse(input);
  if (!parsed.success) throw new NonRetriableError("automation_reference_invalid");
  const { organizationId, outboxEventId } = parsed.data;
  const event = await withTenant(db, organizationId, tx => new OutboxRepository(tx,organizationId).event(outboxEventId));
  if (!event || event.type !== eventType || !(automationEvents as readonly string[]).includes(eventType)) throw new NonRetriableError("automation_reference_denied");
  return enqueueAutomationEvent(organizationId,outboxEventId,{db});
}
const triggerGroups = Array.from({length:Math.ceil(automationEvents.length/10)},(_,index)=>automationEvents.slice(index*10,index*10+10));
export const consumeAutomations = triggerGroups.map((triggers,index)=>inngest.createFunction({ id:`automation-events-${index+1}`,name:`ALVILLAS OS automation events ${index+1}`,
  triggers:triggers.map(event=>({event})),retries:3,concurrency:{limit:5}
},async({event,step})=>{
  const runs=await step.run("resolve-durable-source",()=>consumeAutomationReference(event.data,event.name));
  const {organizationId}=outboxDispatchInput.parse(event.data);
  for(const id of runs)await step.run(`execute-${id}`,()=>executeAutomationRun(organizationId,id));
  return {runs:runs.length};
}));
export const cleanupUploadParts = inngest.createFunction({ id: "cleanup-field-upload-parts", name: "ALVILLAS OS temporary upload cleanup",
  triggers: [{ cron: "* * * * *" }], concurrency: { limit: 1 }, retries: 3
}, async ({ step }) => {
  const organizations = await step.run("list-organizations", () => OutboxRepository.organizations(prisma));
  let cleaned = 0, failed = false;
  for (const { id } of organizations) {
    try { cleaned += (await step.run(`cleanup-${id}`, () => cleanupFieldUploadParts(id))).cleaned; }
    catch { failed = true; }
  }
  if (failed) throw new Error("Temporary upload cleanup unavailable");
  return { organizations: organizations.length, cleaned };
});
export const recognizeSupplierInvoices = inngest.createFunction({ id: "supplier-invoice-recognition", name: "ALVILLAS OS financial commands",
  triggers: [{ event: supplierInvoiceRecognitionRequested }, { event: supplierInvoiceReversalRequested },{event:employeeCompensationSubmissionRequested},{event:employeeCompensationRecognitionRequested},{event:employeeMonthlyRunRequested}], concurrency: { limit: 1 }, retries: 3
}, async ({ event, step }) => event.name===employeeMonthlyRunRequested?
  step.run("create-reviewed-monthly-contractual-run",()=>executeEmployeeMonthlyRunReference(event.data,{eventType:event.name})):
  event.name===employeeCompensationRecognitionRequested?
  step.run("recognize-actual-approved-employee-claim",()=>executeEmployeeCompensationRecognitionReference(event.data,{eventType:event.name})):
  event.name===employeeCompensationSubmissionRequested?
  step.run("submit-actual-completed-employee-work",()=>executeEmployeeCompensationSubmissionReference(event.data,{eventType:event.name})):
  step.run(event.name === supplierInvoiceReversalRequested ? "reverse-actual-recognized-invoice" : "recognize-actual-approved-invoice",
  () => executeSupplierInvoiceRecognitionReference(event.data, { eventType: event.name })));
const failedInvoiceExecution = z.object({ function_id: z.literal("alvillas-os-supplier-invoice-recognition"),
  event: z.object({ name: z.enum([supplierInvoiceRecognitionRequested, supplierInvoiceReversalRequested,employeeCompensationSubmissionRequested,employeeCompensationRecognitionRequested,employeeMonthlyRunRequested]), data: outboxDispatchInput }) });
// The SDK's automatic onFailure registration omits concurrency. An explicit consumer
// keeps both workers within the existing plan's checked admission limits.
export const failSupplierInvoiceRecognitions = inngest.createFunction({ id: "supplier-invoice-recognition-failure", name: "ALVILLAS OS supplier recognition failure receipt",
  triggers: [{ event: "inngest/function.failed", if: "event.data.function_id == 'alvillas-os-supplier-invoice-recognition'" }], concurrency: { limit: 1 }, retries: 3
}, async ({ event, step }) => {
  const failure = failedInvoiceExecution.safeParse(event.data);
  if (!failure.success) throw new NonRetriableError("supplier_invoice_failure_reference_denied");
  if(failure.data.event.name===employeeMonthlyRunRequested)return step.run("record-terminal-monthly-run-failure",()=>failEmployeeMonthlyRunReference(failure.data.event.data,{eventType:employeeMonthlyRunRequested}));
  if(failure.data.event.name===employeeCompensationRecognitionRequested)return step.run("record-terminal-employee-recognition-failure",()=>failEmployeeCompensationRecognitionReference(failure.data.event.data,{eventType:employeeCompensationRecognitionRequested}));
  if(failure.data.event.name===employeeCompensationSubmissionRequested)return step.run("record-terminal-employee-submission-failure",()=>failEmployeeCompensationSubmissionReference(failure.data.event.data,{eventType:employeeCompensationSubmissionRequested}));
  return step.run(failure.data.event.name === supplierInvoiceReversalRequested ? "record-terminal-reversal-failure" : "record-terminal-recognition-failure",
    () => failSupplierInvoiceRecognitionReference(failure.data.event.data, { eventType: failure.data.event.name }));
});
export const inngestFunctions = [dispatchOutbox,...consumeAutomations,cleanupUploadParts,recognizeSupplierInvoices,failSupplierInvoiceRecognitions];
