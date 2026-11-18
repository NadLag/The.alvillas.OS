import {z} from "zod";
import {nativeMaintenanceIssueInputSchema} from "@/platform/maintenance/issue-input";
import {maintenanceIssueSourcesSchema} from "./issue-context";
/** Keep the original intake/field contract separate from the private context
 * viewer so that its operational rule graph is not loaded by the context UI. */
export const maintenanceIssueDraftSchema=z.object({issue:nativeMaintenanceIssueInputSchema,sources:maintenanceIssueSourcesSchema}).strict();
