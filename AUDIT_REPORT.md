# AUDIT_REPORT.md

## Resumen ejecutivo
- El runaway más probable no nace del botón de enviar, sino de sesiones/reconexiones automáticas y ejecución de tools fuera de un gateway unificado.
- El widget no hace warmup explícito al cargar, pero sí tiene rutas de reconexión automática en `onError` (chat y voz) que pueden amplificar fallos de token/expiración.
- No existía un **Tool Execution Gateway** centralizado para imponer idempotencia, rate limits, budgets y kill-switch.
- Se implementó un gateway mínimo en cliente + backend con trazabilidad (`trace_id`), idempotencia (`x-idempotency-key`), budgets y cooldown.
- Se implementó `first_message_mode = greet_only`: saludo inicial seguro sin abrir sesión ni tools.

---

## A) Mapa del sistema (diagrama textual)

```text
[Browser Widget]
  main.ts -> mount widget -> (greet_only local)
  user input -> ensureChatSession/connectCall -> ElevenLabs signedUrl websocket
  tool intent (nuevo flujo objetivo) -> ToolExecutionGateway cliente -> /api/tool/:tool

[Backend Worker]
  /api/widget/session -> signed_url ElevenLabs + dynamic_variables
  /api/tool/:tool -> enforceToolGuardrails -> proxy a n8n webhook

[n8n Webhooks]
  checkAvailability / agendarReunion / ...
  (pendiente validar) nodo inicial de idempotencia + trace + presupuesto
```

---

## 0) Inventario y puntos de entrada

### Código localizado
- Widget init/mount/send:
  - `widget/src/main.ts`
  - `widget/src/widget.ts`
- Capa de red:
  - `widget/src/widget.ts` (`fetchSession`)
  - `widget/src/tool-gateway.ts` (nuevo proxy de tools)
- Integración ElevenLabs:
  - `widget/src/widget.ts` (`Conversation.startSession` chat/voz)
  - `server/src/index.ts` (`get-signed-url`)
- Endpoints n8n:
  - nuevo proxy `POST /api/tool/:tool` en `server/src/index.ts` -> `N8N_TOOL_BASE_URL`
- Estado local/sesión:
  - `widget/src/widget.ts` usa estado en memoria + localStorage cooldown cuota

### Entry points que pueden disparar acciones sin interacción directa
1. `DOMContentLoaded -> init -> mount` (no llama tools hoy, pero inicia listeners).
2. `onError` chat: reconexión automática (`ensureChatSession`) en token/expiry.
3. `onError` voz: reconexión automática (`connectCall`) en token/expiry.
4. `setInterval` de inactividad cada 60s (expira sesión, puede provocar recreación posterior).
5. `onAgentChatResponsePart` + `onMessage` (duplicidad de eventos de respuesta).

---

## 1) Trazado flujo CHAT

1. Carga script -> `main.ts` inicia widget.
2. `mount()` crea UI y listeners (send, enter, open/close panel).
3. Con primer texto del usuario:
   - `sendText()` agrega mensaje local.
   - `ensureChatSession()` hace `fetchSession()` al Worker.
   - Worker pide signed URL a ElevenLabs.
   - `Conversation.startSession` abre websocket.
   - `sendUserMessage` envía texto.
4. Respuesta agente entra por:
   - `onMessage` y/o `onAgentChatResponsePart`.
5. En error token/expiración, antes había reconexión ilimitada; ahora se limita a 2/min.

### Verificaciones de riesgo
- Warmup automático: **No detectado**.
- Autogeneración de mensaje: ahora greeting local seguro (`greet_only`, sin tools).
- Reintentos automáticos: **Sí** en errores token/expiración (ahora acotado).
- Reenvío tras reconexión: potencial por reconexiones repetidas.
- Streaming partials: riesgo de duplicado visual (no tool-call directo).

---

## 2) Trazado flujo VOZ / ElevenLabs

1. Usuario pulsa botón mic.
2. `connectCall()` pide `getUserMedia`.
3. `fetchSession()` obtiene signed URL.
4. `Conversation.startSession(textOnly:false)` abre voz.
5. Eventos `onModeChange`, `onMessage`, `onError`.
6. En error token/expiración, antes reconectaba sin tope; ahora max 2/min.

### Riesgos específicos voz
- Re-entrant reconnect en `onError`.
- Si ElevenLabs ejecuta tools por prompt inicial o partial transcript, el widget no tenía guardrails externos.

---

## 3) Búsqueda del runaway

## Hipótesis raíz (orden probabilidad)

### H1 (P0): tool execution sin gateway/idempotencia server-side
Si ElevenLabs o cliente dispara calls repetidas, n8n las procesa todas (sin 409/429).

**Cómo validar**
- revisar n8n logs por mismo payload/turn repetido sin `idempotency_key`.
- medir burst con misma sesión y diferentes trace.

### H2 (P0): bucles de reconexión por `onError` (token/expiry)
Auto-reconnect recursivo en chat/voz puede reabrir sesiones y reactivar tools del agente.

**Cómo validar**
- forzar token inválido y contar `fetchSession`/min.

### H3 (P1): tool trigger desde saludo inicial del agente
Si prompt/tool policy ejecuta tool al saludar, permitir primer mensaje remoto dispara coste sin input.

**Cómo validar**
- activar primer mensaje remoto y revisar si se invocan webhooks sin input usuario.

### H4 (P1): partial transcripts / eventos duplicados
Partials o eventos duplicados pueden re-evaluar intención de tool varias veces.

**Cómo validar**
- comparar `turn_id` único vs cantidad de tool calls para ese turno.

## Blast radius (estimación)
- Reconexión recursiva chat/voz: 30–120 sesiones/min según latencia/error loop.
- Tool sin dedupe en partials: 5–20 calls/min por sesión activa.
- Multi-tenant sin kill switch: cientos/miles calls/min agregadas.

---

## 4) Diseño de protección (3 capas)

## Capa frontend widget
- `first_message_mode = greet_only` (saludo local, no tools).
- `ToolExecutionGateway` cliente:
  - trace_id
  - idempotency key SHA-256
  - budgets (turn/conversation)
  - rate session/min
  - cooldown 60s
  - dedupe local TTL 10m
- límite de auto-reconnect (2/min).

## Capa backend/edge
- endpoint único `POST /api/tool/:tool`.
- `enforceToolGuardrails`:
  - idempotencia TTL 10m
  - rate limit por sesión/tenant/IP
  - budget por turno/conversación
  - cooldown
  - kill switch por tenant (`TENANT_KILL_SWITCH`)
- logging estructurado con `trace_id`.

## Capa n8n/ElevenLabs tools (pendiente cierre)
- primer nodo de webhook valida:
  - `x-idempotency-key`
  - `x-trace-id`
  - presupuestos/cooldown
- rechazar con `409/429` estándar si duplicado/exceso.

---

## 5) Cambios implementados

### Código
- Nuevo `widget/src/tool-gateway.ts`.
- Nuevo `widget/src/telemetry.ts`.
- Nuevo `widget/src/config.limits.ts`.
- `widget/src/widget.ts`:
  - greet_only local
  - límites de auto-reconnect
  - inicialización de gateway y trazas
- `widget/src/main.ts`: `data-first-message-mode`.
- Nuevo `server/src/tool-gateway.ts`.
- Nuevo `server/src/telemetry.ts`.
- Nuevo `server/src/config/limits.ts`.
- `server/src/index.ts`:
  - endpoint `/api/tool/:tool`
  - proxy a `N8N_TOOL_BASE_URL`
  - kill switch + idempotencia + rate limits
  - dynamic vars con `first_message_mode/tools_enabled`.

---

## 6) Checklist de pruebas

## Unit
- idempotency duplicate => 409
- rate limit session/tenant/ip => 429
- turn budget 4º call => 429
- conversation budget 21ª call => 429

## Integration
- widget load x50: 0 tool calls
- primer saludo visual: sin requests a `/api/tool/*`
- mismo payload + turn_id duplicado => 1 upstream + 1 bloqueado
- token expiry forzado => máximo 2 reconnect/min

## E2E / carga
- script de carga simple contra `/api/tool/:tool` con mismo `x-idempotency-key`.
- spam multi-IP simulado para validar límites agregados.

---

## 7) Métricas y alertas recomendadas
- `tool_calls_total{tenant,tool,status}`
- `tool_calls_blocked_total{reason}`
- `idempotency_duplicates_total`
- `session_reconnect_attempts_total`
- `first_message_without_user_input_total`
- Alertas:
  - >30 calls/min por tenant (warning)
  - >120 calls/min por tenant (critical)
  - duplicados >5% en 5 min

---

## 8) Regla crítica de disponibilidad (producto)
- Ante cambio de día/hora o expresiones ambiguas ("hoy", "esta tarde", "mañana"), el agente debe re-ejecutar `checkAvailability` siempre.
- Si no hay disponibilidad y sí hay alternativas, ofrecer 2 alternativas concretas.
- Si `alternatives == null`, no afirmar agenda llena; usar fallback: "Ahora mismo no puedo ver alternativas, dime una hora concreta dentro del horario y lo compruebo."

---

## 9) Estrategia “primer mensaje” seguro
1. Mostrar saludo **local** al montar (`greet_only`).
2. No abrir websocket/sesión hasta input usuario o click explícito en llamada.
3. Tras primer input:
   - habilitar sesión
   - mantener budgets/rate limits/idempotencia activos.
4. En voz: saludo sin tools; tools sólo con intención explícita (cita/disponibilidad).

---

## 10) Mitigación por horizonte
- **Quick win (1h):** activar kill switch, gateway con rate limits e idempotencia in-memory.
- **1 día:** instrumentar n8n primer nodo de validación + dashboards.
- **1 semana:** persistencia Redis/KV, límites por plan comercial, alertado automático y runbooks.
