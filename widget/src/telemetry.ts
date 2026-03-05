export type TelemetryLevel = "info" | "warn" | "error";

export type TelemetryEvent = {
  trace_id: string;
  session_id?: string;
  tenant_id?: string;
  event: string;
  level?: TelemetryLevel;
  meta?: Record<string, unknown>;
};

export function createTraceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `trace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function telemetryLog(evt: TelemetryEvent, debug = false) {
  if (!debug) return;
  const level = evt.level ?? "info";
  const payload = {
    ts: new Date().toISOString(),
    ...evt,
  };
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"]("[SolAI][telemetry]", payload);
}
