export const LIMITS = {
  toolBudget: {
    perTurn: 3,
    perConversation: 20,
    perSessionPerMinute: 6,
    perTenantPerMinute: 120,
    perIpPerMinute: 30,
    cooldownSeconds: 60,
  },
  idempotencyTtlMs: 10 * 60_000,
} as const;
