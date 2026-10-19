import type { NormalizedReservation } from "@/modules/reservations/domain/reservation";

export type ReservationAdapterInput = { content: string; source: NormalizedReservation["source"]; timezone: string; dateFormat?: "ISO" | "MDY" | "DMY" };
export interface NormalizedReservationAdapter {
  normalize(input: ReservationAdapterInput): NormalizedReservation[];
}
