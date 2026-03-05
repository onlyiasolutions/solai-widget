# SolAI Widget

Widget embed universal que integra **ElevenLabs ElevenAgents** (voz + chat) usando **Signed URLs** desde un backend, sin exponer API keys.

## Estructura del proyecto

```
.
├── package.json           # Root: scripts dev, build, preview
├── pnpm-workspace.yaml
├── .env.example
├── demo/
│   └── index.html         # Demo page (preview)
├── widget/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html         # Demo page (dev)
│   ├── src/
│   │   ├── main.ts        # Entry IIFE
│   │   ├── widget.ts      # Lógica del widget
│   │   └── styles.ts      # CSS Shadow DOM
│   └── dist/
│       └── solai-widget.js  # Build producción
└── server/
    ├── package.json
    ├── tenants.json       # Config tenant -> agentId, branding
    └── src/
        ├── index.ts       # Express app
        ├── routes/widget.ts
        └── middleware/rateLimit.ts
```

## Instalación

```bash
# Clonar / entrar al proyecto
cd NEXO

# Instalar dependencias (npm o pnpm)
npm install
# o
pnpm install
```

## Configuración

1. **Copiar `.env.example` a `.env`**:
   ```bash
   cp .env.example .env
   ```

2. **Configurar `ELEVENLABS_API_KEY`** en `.env`:
   - Obtener en: https://elevenlabs.io/app/settings/api-keys
   - ⚠️ NUNCA expongas esta clave al cliente

3. **Configurar `agentId` en `server/tenants.json`**:
   - Sustituir cada `REPLACE_WITH_YOUR_AGENT_ID` por el ID real de tu agente
   - Obtener IDs en: https://elevenlabs.io/app/conversational-ai

Ejemplo:

```json
{
  "demo-dental": {
    "agentId": "abc123xyz-tu-agent-id-aqui",
    "branding": {
      "name": "Clínica Dental Demo",
      "primaryColor": "#059669",
      "logoUrl": ""
    }
  }
}
```

## Scripts

| Script | Descripción |
|--------|-------------|
| `npm run dev` / `pnpm dev` | Levanta server (API) + frontend (Vite) en paralelo |
| `npm run build` / `pnpm build` | Construye `widget/dist/solai-widget.js` |
| `npm run preview` / `pnpm preview` | Build + sirve demo y widget en `http://localhost:3000` |

## Cómo ejecutar

### Modo desarrollo

```bash
npm run dev
# o: pnpm dev
```

- **API**: http://localhost:3000  
- **Demo (Vite)**: http://localhost:5173  

Abre http://localhost:5173 para ver el widget con hot-reload.

### Modo preview (build de producción)

```bash
npm run preview
# o: pnpm run build && pnpm preview
```

- Todo en: http://localhost:3000  
- Demo: http://localhost:3000  
- Widget: http://localhost:3000/solai-widget.js  

## Cómo embeber en cualquier web

1. Construye el widget: `npm run build`
2. Sirve `widget/dist/solai-widget.js` desde tu dominio o CDN
3. Incluye el script en tu HTML con los atributos `data-*`:

```html
<script
  src="https://tu-dominio.com/solai-widget.js"
  data-tenant="demo-dental"
  data-position="br"
  data-mode="voice+chat"
  data-primary-color="#059669"
  data-api-base="https://tu-api.com"
></script>
```

### Atributos soportados

| Atributo | Valores | Default |
|----------|---------|---------|
| `data-tenant` | ID del tenant (ej. demo-dental) | demo-dental |
| `data-position` | br, bl, tr, tl | br |
| `data-mode` | chat, voice, voice+chat | voice+chat |
| `data-primary-color` | Color CSS (#xxx, rgb) | #2563eb |
| `data-api-base` | URL base del API | `https://solai-widget-api.wesolailabs.workers.dev` |

## Cómo añadir nuevos tenants

1. Edita `server/tenants.json`
2. Añade una nueva entrada:

```json
"mi-tenant": {
  "agentId": "tu-agent-id-de-elevenlabs",
  "branding": {
    "name": "Mi Negocio",
    "primaryColor": "#2563eb",
    "logoUrl": "https://..."
  }
}
```

3. Obtén `agentId` en: https://elevenlabs.io/app/conversational-ai  
4. Reinicia el servidor (o usa `tsx watch` en dev)

## Cómo probar

1. **Configurar agentId real**: Reemplaza `REPLACE_WITH_YOUR_AGENT_ID` en `server/tenants.json` con un agentId válido de ElevenLabs.
2. **Modo dev**: `npm run dev` → abrir http://localhost:5173
3. **Modo preview**: `npm run preview` → abrir http://localhost:3000
4. **Permisos de micrófono**: En modo voice/voice+chat, el navegador pedirá micrófono. Si lo deniegas, el widget hace fallback a chat por texto.

## Seguridad

- **ELEVENLABS_API_KEY** nunca se envía al cliente; se usa solo en el servidor para obtener Signed URLs
- **CORS**: Permitido solo para localhost en desarrollo
- **Rate limit**: 60 peticiones/minuto por IP (in-memory)
- **Signed URLs**: Válidas ~15 min; el widget reconecta si expiran

## API Backend

### GET /widget/tenant?tenant=<slug>

Devuelve config del tenant.

### POST /widget/session

Body:

```json
{
  "tenant": "demo-dental",
  "client_session_id": "optional-client-id"
}
```

Devuelve:

```json
{
  "tenant": "demo-dental",
  "session_id": "client-id-or-generated-uuid",
  "ttl_seconds": 900,
  "agentId": "abc123",
  "signedUrl": "wss://api.elevenlabs.io/v1/convai/conversation?...",
  "branding": { "name": "...", "primaryColor": "...", "logoUrl": "..." }
}
```

El cliente usa `signedUrl` con el SDK de ElevenLabs para conectar sin exponer la API key.

### POST /widget/message

Body:

```json
{
  "session_id": "uuid",
  "text": "Hola",
  "idempotency_key": "uuid"
}
```

Respuesta actual: `501` (el transporte de mensajes del widget va por websocket de ElevenLabs).

### POST /widget/reset

Body:

```json
{
  "session_id": "uuid"
}
```

Respuesta:

```json
{
  "ok": true,
  "session_id": "uuid"
}
```

### GET /health

Estado del worker.

## Local (rápido y correcto)

### Opción 1: Widget local apuntando a Worker de prod

```bash
npm run dev:widget
```

Abre:

```text
http://localhost:5173/?apiBase=https://solai-widget-api.wesolailabs.workers.dev
```

Embed de ejemplo:

```html
<script
  src="https://tu-cdn.com/solai-widget.js"
  data-tenant="demo-dental"
  data-api-base="https://solai-widget-api.wesolailabs.workers.dev"
  data-position="br"
  data-mode="voice+chat"
></script>
```

### Opción 2: Worker local con wrangler dev

```bash
npm run dev:widget:worker
```

Abre:

```text
http://localhost:5173/?apiBase=http://127.0.0.1:8787
```

También puedes fijarlo por variable de entorno:

```bash
VITE_WIDGET_API_BASE=http://127.0.0.1:8787 npm run dev:widget
```

## CORS (worker)

Orígenes permitidos por defecto:

- `http://localhost:3000`
- `http://localhost:5173`
- `https://solai-widget-api.wesolailabs.workers.dev`

Override por env:

```bash
WIDGET_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173,https://solai-widget-api.wesolailabs.workers.dev"
```
