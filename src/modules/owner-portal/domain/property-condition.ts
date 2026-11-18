export type OwnerPropertyCondition = "CLEAR" | "ATTENTION" | "WORK_UNDERWAY";

export function ownerPropertyCondition(signals: { openIssue: boolean; waitingForWork: boolean }): OwnerPropertyCondition {
  if (!signals.openIssue) return "CLEAR";
  return signals.waitingForWork ? "ATTENTION" : "WORK_UNDERWAY";
}
