import {z} from "zod";
export const taskTypeSchema = z.enum([
  "ARRIVAL_PREPARATION",
  "CHECKOUT_CLEANING",
  "CLEANING_MIDSTAY",
  "INSPECTION",
  "POOL",
  "GARDEN",
  "MAINTENANCE",
  "CLEANING",
  "LAUNDRY",
  "INVENTORY",
  "CHEF",
  "TRANSFER",
  "CUSTOM"
]);
