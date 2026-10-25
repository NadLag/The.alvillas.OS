import { z } from "zod";
import { countedStockQuantitySchema, stockQuantitySchema, stockRevisionSchema } from "./stocktake";

export const stocktakeEventDataSchema = z.object({
  id: z.uuid(), expected: stockQuantitySchema, actual: countedStockQuantitySchema,
  delta: stockQuantitySchema, revision: stockRevisionSchema
}).strict();
