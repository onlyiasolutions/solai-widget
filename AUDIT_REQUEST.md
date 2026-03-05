# AUDIT_REQUEST.md

## Información faltante para cerrar auditoría al 100%

1. **Configuración real de ElevenLabs Agent**
   - Prompt del sistema actual.
   - Definición exacta de tools (nombres, schemas, webhook URLs).
   - Si está activado "immediate tool execution".
   - Política de retries/timeouts de tools en ElevenLabs.

2. **n8n Webhooks productivos**
   - URL base real de webhooks y mapeo tool -> webhook.
   - Si hoy validan `x-idempotency-key` y `x-trace-id`.
   - Si tienen nodos de dedupe/cooldown/rate-limit.

3. **Infra de persistencia para guardrails server-side**
   - Confirmar si existe Redis/KV/D1 para mover contadores e idempotencia fuera de memoria.
   - SLA de retención de logs + stack de observabilidad.

4. **Política multi-tenant**
   - Límite por tenant contratado (calls/min, calls/day).
   - Lista de tenants críticos para activar kill-switch por defecto.

> Mientras llega esta información, se dejó implementado un gateway mínimo funcional (in-memory) y documentación de endurecimiento.
