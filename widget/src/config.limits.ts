export type ToolLimits = {
  perTurn: number;
  perConversation: number;
  perSessionPerMinute: number;
  cooldownMs: number;
  idempotencyTtlMs: number;
};

export const TOOL_LIMITS: ToolLimits = {
  perTurn: 3,
  perConversation: 20,
  perSessionPerMinute: 6,
  cooldownMs: 60_000,
  idempotencyTtlMs: 10 * 60_000,
};

export const FIRST_MESSAGE_MODE = "greet_only" as const;
