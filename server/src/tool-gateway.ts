import { LIMITS } from "./config/limits";
import { logTrace } from "./telemetry";

type Counter = { count: number; resetAt: number };

const idemStore = new Map<string, number>();
const conversationCounters = new Map<string, number>();
const cooldowns = new Map<string, number>();
const perSessionCounters = new Map<string, Counter>();
const perTenantCounters = new Map<string, Counter>();
const perIpCounters = new Map<string, Counter>();

function now() {
  return Date.now();
}

function countInWindow(map: Map<string, Counter>, key: string, max: number): boolean {
  const currentTs = now();
  const existing = map.get(key);
  if (!existing || currentTs > existing.resetAt) {
    map.set(key, { count: 1, resetAt: currentTs + 60_000 });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  map.set(key, existing);
  return true;
}

function cleanupExpired() {
  const currentTs = now();
  for (const [k, v] of idemStore) {
    if (v <= currentTs) idemStore.delete(k);
  }
}

export type ToolGuardInput = {
  traceId: string;
  sessionId: string;
  tenantId: string;
  ip: string;
  idempotencyKey: string;
  turnId: string;
  toolName: string;
};

export type ToolGuardResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; retry_after_s?: number };

export function enforceToolGuardrails(input: ToolGuardInput): ToolGuardResult {
  cleanupExpired();

  const tenantKill = (globalThis as any).SOLAI_TENANT_KILL_SWITCH as string | undefined;
  if (tenantKill && tenantKill.split(",").map((x) => x.trim()).includes(input.tenantId)) {
    logTrace("tool.block.kill_switch", input.traceId, { tenant_id: input.tenantId, tool: input.toolName });
    return { ok: false, status: 503, code: "kill_switch", message: "Tool execution disabled for tenant" };
  }

  if (idemStore.has(input.idempotencyKey)) {
    logTrace("tool.block.idempotent", input.traceId, { tenant_id: input.tenantId, session_id: input.sessionId, tool: input.toolName });
    return { ok: false, status: 409, code: "duplicate", message: "Duplicate tool call" };
  }

  const cooldownKey = `${input.tenantId}:${input.sessionId}`;
  const cooldownUntil = cooldowns.get(cooldownKey) ?? 0;
  if (cooldownUntil > now()) {
    return {
      ok: false,
      status: 429,
      code: "cooldown",
      message: "Tool calls blocked by cooldown",
      retry_after_s: Math.ceil((cooldownUntil - now()) / 1000),
    };
  }

  const sessionAllowed = countInWindow(
    perSessionCounters,
    `${input.tenantId}:${input.sessionId}`,
    LIMITS.toolBudget.perSessionPerMinute
  );
  const tenantAllowed = countInWindow(
    perTenantCounters,
    input.tenantId,
    LIMITS.toolBudget.perTenantPerMinute
  );
  const ipAllowed = countInWindow(perIpCounters, input.ip, LIMITS.toolBudget.perIpPerMinute);

  if (!sessionAllowed || !tenantAllowed || !ipAllowed) {
    cooldowns.set(cooldownKey, now() + LIMITS.toolBudget.cooldownSeconds * 1000);
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "Tool rate limit exceeded",
      retry_after_s: LIMITS.toolBudget.cooldownSeconds,
    };
  }

  const turnCounterKey = `${input.sessionId}:${input.turnId}`;
  const turnCount = conversationCounters.get(turnCounterKey) ?? 0;
  if (turnCount >= LIMITS.toolBudget.perTurn) {
    return { ok: false, status: 429, code: "turn_budget", message: "Turn tool budget exceeded" };
  }

  const convoCounterKey = `${input.tenantId}:${input.sessionId}`;
  const convoCount = conversationCounters.get(convoCounterKey) ?? 0;
  if (convoCount >= LIMITS.toolBudget.perConversation) {
    cooldowns.set(cooldownKey, now() + LIMITS.toolBudget.cooldownSeconds * 1000);
    return {
      ok: false,
      status: 429,
      code: "conversation_budget",
      message: "Conversation tool budget exceeded",
      retry_after_s: LIMITS.toolBudget.cooldownSeconds,
    };
  }

  conversationCounters.set(turnCounterKey, turnCount + 1);
  conversationCounters.set(convoCounterKey, convoCount + 1);
  idemStore.set(input.idempotencyKey, now() + LIMITS.idempotencyTtlMs);
  return { ok: true };
}
