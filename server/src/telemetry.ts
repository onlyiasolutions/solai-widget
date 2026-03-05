export type TraceMeta = Record<string, unknown>;

export function traceIdFromReq(req: Request): string {
  const fromHeader = req.headers.get("x-trace-id");
  if (fromHeader) return fromHeader;
  return crypto.randomUUID();
}

export function logTrace(event: string, traceId: string, meta: TraceMeta = {}) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, trace_id: traceId, ...meta }));
}
