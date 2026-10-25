import { z } from "zod";

export const configSlugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9_.-]+$/u);
