let perfOn = false;

/** Enable with ?perf=1 or localStorage yiroPerf=1 */
export function initPerfFromUrl(): void {
  try {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("perf");
    if (q === "1") perfOn = true;
    if (window.localStorage.getItem("yiroPerf") === "1") perfOn = true;
  } catch {
    /* ignore */
  }
}

export function isPerfEnabled(): boolean {
  return perfOn;
}

export function perfMark(name: string): void {
  if (!perfOn) return;
  try {
    performance.mark(name);
  } catch {
    /* ignore */
  }
}

export function perfMeasure(name: string, startMark: string, endMark?: string): void {
  if (!perfOn) return;
  try {
    if (endMark) performance.measure(name, startMark, endMark);
    else performance.measure(name, startMark);
  } catch {
    /* ignore */
  }
}
