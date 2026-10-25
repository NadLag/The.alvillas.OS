export const maximumUploadGeneration = 2_147_483_647;

export function isUploadGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximumUploadGeneration;
}
