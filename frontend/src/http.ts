/** Shared fetch helpers for gradual TypeScript migration. */

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "CanceledError";
}
