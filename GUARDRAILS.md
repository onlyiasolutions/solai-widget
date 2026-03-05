# GUARDRAILS.md

## Política de ejecución de tools (v1)

## 1) Regla de oro
**Toda ejecución de tool debe pasar por `Tool Execution Gateway`**.

- Cliente: `widget/src/tool-gateway.ts`
- Backend: `server/src/tool-gateway.ts`
- Proxy a n8n: `POST /api/tool/:tool` (`server/src/index.ts`)

## 2) Identidad y trazabilidad obligatoria
Headers obligatorios por tool call:
- `x-trace-id` (uuid por llamada)
- `x-session-id` (persistente por conversación)
- `x-tenant-id`
- `x-idempotency-key`
- `x-turn-id`

Payload mínimo:
```json
{
  "turn_id": "turn-uuid",
  "payload": { "...": "..." }
}
```

## 3) Presupuestos (budget)
Configuración base (`server/src/config/limits.ts`):
- `perTurn = 3`
- `perConversation = 20`
- `perSessionPerMinute = 6`
- `perTenantPerMinute = 120`
- `perIpPerMinute = 30`
- `cooldownSeconds = 60`

## 4) Idempotencia + dedupe
- Cliente genera `idempotency_key = sha256(session_id + tool_name + normalized_payload + turn_id)`.
- Backend rechaza duplicados (`409 duplicate`) con TTL 10 minutos.
- n8n debe revalidar la misma key en el primer nodo.

## 5) Cooldown y bloqueo
Cuando se excede presupuesto/rate limit:
- respuesta `429`
- `code: rate_limited | turn_budget | conversation_budget | cooldown`
- `retry_after_s`
- bloqueo de 60s por `tenant:session`.

## 6) Kill switch remoto
Variable de entorno backend:
- `TENANT_KILL_SWITCH="tenant-a,tenant-b"`

Si tenant está en la lista:
- `503 kill_switch`
- no se envía nada a n8n.

## 7) First message seguro
Modo por defecto: `first_message_mode = greet_only`.

Reglas:
1. El saludo inicial lo renderiza el widget localmente.
2. No abre sesión ni dispara tools.
3. Tools habilitadas solo después de primer input real del usuario.

## 8) Regla crítica de disponibilidad (producto)
Cuando el usuario cambie día/hora o use expresiones ambiguas ("hoy", "esta tarde", "mañana"):
1. Ejecutar **siempre** `checkAvailability` de nuevo.
2. Si `available = false` y `alternatives != null`, ofrecer exactamente 2 alternativas.
3. Si `alternatives == null`, responder con fallback funcional (no afirmar agenda llena):
   - "Ahora mismo no puedo ver alternativas, dime una hora concreta dentro del horario y lo compruebo."

## 9) Respuesta estándar de rechazo
```json
{
  "error": "rate_limited",
  "message": "Tool rate limit exceeded",
  "retry_after_s": 60,
  "trace_id": "..."
}
```

## 10) Endurecimiento siguiente fase
- mover mapas in-memory a Redis/KV.
- métricas por tenant + alertas automáticas.
- firma HMAC del payload hacia n8n.
