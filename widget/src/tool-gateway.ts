import { TOOL_LIMITS } from "./config.limits";
import { createTraceId, telemetryLog } from "./telemetry";

type GatewayInit = {
  apiBase: string;
  tenantId: string;
  sessionId: string;
  debug?: boolean;
};

type ToolPayload = Record<string, unknown>;

type Bucket = { count: number; resetAt: number };

type ToolGatewayResult = {
  ok: boolean;
  blocked?: boolean;
  reason?: string;
  status?: number;
  trace_id: string;
  data?: unknown;
};

export class ToolExecutionGateway {
  private readonly apiBase: string;
  private readonly tenantId: string;
  private readonly sessionId: string;
  private readonly debug: boolean;
  private readonly dedupe = new Map<string, number>();
  private minuteBucket: Bucket = { count: 0, resetAt: Date.now() + 60_000 };
  private turnCalls = 0;
  private convoCalls = 0;
  private cooldownUntil = 0;

  constructor(init: GatewayInit) {
    this.apiBase = init.apiBase.replace(/\/+$/, "");
    this.tenantId = init.tenantId;
    this.sessionId = init.sessionId;
    this.debug = !!init.debug;
  }

  startTurn() {
    this.turnCalls = 0;
  }

  private cleanupDedupe() {
    const now = Date.now();
    for (const [key, expires] of this.dedupe) {
      if (expires <= now) this.dedupe.delete(key);
    }
  }

  private checkWindowLimit(): string | null {
    const now = Date.now();
    if (now > this.minuteBucket.resetAt) {
      this.minuteBucket = { count: 0, resetAt: now + 60_000 };
    }
    if (this.minuteBucket.count >= TOOL_LIMITS.perSessionPerMinute) {
      this.cooldownUntil = now + TOOL_LIMITS.cooldownMs;
      return "rate_limit_session";
    }
    return null;
  }

  private checkBudget(): string | null {
    const now = Date.now();
    if (this.cooldownUntil && now < this.cooldownUntil) return "cooldown";
    if (this.turnCalls >= TOOL_LIMITS.perTurn) return "turn_budget";
    if (this.convoCalls >= TOOL_LIMITS.perConversation) {
      this.cooldownUntil = now + TOOL_LIMITS.cooldownMs;
      return "conversation_budget";
    }
    return this.checkWindowLimit();
  }

  private async createIdempotencyKey(toolName: string, payload: ToolPayload, turnId: string) {
    const normalized = JSON.stringify(payload, Object.keys(payload).sort());
    const raw = `${this.sessionId}|${toolName}|${normalized}|${turnId}`;

    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async callTool(toolName: string, payload: ToolPayload, turnId: string): Promise<ToolGatewayResult> {
    this.cleanupDedupe();
    const trace_id = createTraceId();

    const blockedReason = this.checkBudget();
    if (blockedReason) {
      telemetryLog({ trace_id, session_id: this.sessionId, tenant_id: this.tenantId, event: "tool.blocked", level: "warn", meta: { blockedReason, toolName } }, this.debug);
      return { ok: false, blocked: true, reason: blockedReason, status: 429, trace_id };
    }

    const idempotencyKey = await this.createIdempotencyKey(toolName, payload, turnId);
    if (this.dedupe.has(idempotencyKey)) {
      telemetryLog({ trace_id, session_id: this.sessionId, tenant_id: this.tenantId, event: "tool.duplicate_client", level: "warn", meta: { toolName } }, this.debug);
      return { ok: false, blocked: true, reason: "duplicate", status: 409, trace_id };
    }

    this.dedupe.set(idempotencyKey, Date.now() + TOOL_LIMITS.idempotencyTtlMs);

    const url = `${this.apiBase}/api/tool/${encodeURIComponent(toolName)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trace-id": trace_id,
        "x-session-id": this.sessionId,
        "x-tenant-id": this.tenantId,
        "x-idempotency-key": idempotencyKey,
        "x-turn-id": turnId,
      },
      body: JSON.stringify({ payload, turn_id: turnId }),
    });

    this.turnCalls += 1;
    this.convoCalls += 1;
    this.minuteBucket.count += 1;

    if (!res.ok) {
      telemetryLog({ trace_id, session_id: this.sessionId, tenant_id: this.tenantId, event: "tool.server_reject", level: "warn", meta: { status: res.status, toolName } }, this.debug);
      return { ok: false, blocked: true, reason: "server_reject", status: res.status, trace_id };
    }

    const data = await res.json().catch(() => ({}));
    telemetryLog({ trace_id, session_id: this.sessionId, tenant_id: this.tenantId, event: "tool.success", meta: { toolName } }, this.debug);
    return { ok: true, data, trace_id, status: res.status };
  }
}
