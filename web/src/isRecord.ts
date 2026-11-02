/** Narrow JSON payloads to string-keyed objects; arrays are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
