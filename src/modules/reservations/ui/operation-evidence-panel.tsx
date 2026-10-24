import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { getTranslations, getFormatter } from "next-intl/server";
import { taskEvidence } from "../application/operation-evidence";
import {
  operationTaskDetail,
  taskResource,
} from "../application/operation-service";
import type { ReservationActorContext } from "../application/reservation-access";
import { authorize } from "@/platform/authz/authorize";
import { OperationForm } from "./operation-form";
import { taskPriorities } from "../domain/operation-task";
export async function OperationEvidencePanel({
  ctx,
  taskId,
  locale,
  attachmentForm,
}: {
  ctx: ReservationActorContext;
  taskId: string;
  locale: string;
  attachmentForm?: ReactNode;
}) {
  const [t, f, data, detail] = await Promise.all([
      getTranslations({ locale, namespace: "Operations.manage" }),
      getFormatter({ locale }),
      taskEvidence(ctx, taskId),
      operationTaskDetail(ctx, taskId),
    ]),
    resource = taskResource(detail.task);
  return (
    <section className="panel" data-testid="task-evidence-panel">
      <h2>{t("evidence")}</h2>
      {data.evidence.length ? (
        <ul>
          {data.evidence.map((row) => (
            <li key={row.id}>
              <p>{row.note}</p>
              <small>
                {f.dateTime(row.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </small>
              {row.contentType ? (
                <a
                  href={`/api/operations/evidence/${row.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("viewPhoto")}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("noEvidence")}</p>
      )}
      {authorize(ctx.authContext, "edit", resource) ? (
        attachmentForm ??
        <OperationForm
          operation="evidence"
          locale={locale}
          taskId={taskId}
          idempotencyKey={randomUUID()}
          submit={t("attachEvidence")}
        >
          <label>
            {t("photo")}
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png"
              capture="environment"
            />
          </label>
        </OperationForm>
      ) : null}
      <h2>{t("issues")}</h2>
      {data.issues.length ? (
        <ul>
          {data.issues.map((issue) => (
            <li key={issue.id}>
              <strong>{issue.title}</strong>
              <p>{issue.description}</p>
              <span>{t(`priorities.${issue.severity}`)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("noIssues")}</p>
      )}
      {authorize(ctx.authContext, "create", { ...resource, type: "issue" }) ? (
        <OperationForm
          operation="issue"
          locale={locale}
          taskId={taskId}
          idempotencyKey={randomUUID()}
          submit={t("reportIssue")}
        >
          <label>
            {t("issueTitle")}
            <input name="title" required maxLength={240} />
          </label>
          <label>
            {t("priority")}
            <select name="severity" defaultValue="NORMAL">
              {taskPriorities.map((p) => (
                <option key={p} value={p}>
                  {t(`priorities.${p}`)}
                </option>
              ))}
            </select>
          </label>
        </OperationForm>
      ) : null}
    </section>
  );
}
