import { z } from "zod";

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

export const regionInputSchema = z.object({
  name: requiredText(120),
  code: optionalText(24).transform((value) => value?.toUpperCase()),
  description: optionalText(500),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0)
});

export const cityInputSchema = z.object({
  regionId: z
    .preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().uuid().optional()
    ),
  name: requiredText(120),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .default("MA"),
  timezone: requiredText(80).default("Africa/Casablanca"),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0)
});

export type RegionInput = z.infer<typeof regionInputSchema>;
export type CityInput = z.infer<typeof cityInputSchema>;

export type RegionSummary = RegionInput & {
  id: string;
  cityCount: number;
  propertyCount: number;
  archivedAt: Date | null;
  createdAt: Date;
};

export type CitySummary = CityInput & {
  id: string;
  regionName: string | null;
  propertyCount: number;
  archivedAt: Date | null;
  createdAt: Date;
};

export type GeographySummary = {
  regions: RegionSummary[];
  cities: CitySummary[];
};
