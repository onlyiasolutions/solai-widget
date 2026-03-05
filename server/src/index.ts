import tenants from "../tenants.json";
import { enforceToolGuardrails } from "./tool-gateway";
import { logTrace, traceIdFromReq } from "./telemetry";
import { SAFE_SYSTEM_PROMPT } from "./safety-system-prompt";

type Branding = { name: string; primaryColor: string; logoUrl?: string };
type TenantConfig = { agentId: string; branding: Branding; allowed_origins?: string[] };
type TenantsMap = Record<string, TenantConfig>;

export interface Env {
  ELEVENLABS_API_KEY?: string;
  N8N_TOOL_BASE_URL?: string;
  TENANT_KILL_SWITCH?: string;
  WIDGET_ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: string;
}

const TENANTS: TenantsMap = tenants as unknown as TenantsMap;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

const CORS_ALLOW_METHODS = "GET,POST,OPTIONS";
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-Solai-Tenant, X-Tenant, X-Idempotency-Key";
const CORS_MAX_AGE = "86400";
const DEV_ORIGINS = new Set(["http://localhost:3000", "http://localhost:5173"]);

function isWidgetPath(pathname: string) {
  return /^\/(?:api\/)?widget(?:\/|$)/.test(pathname);
}

function getTenantForCors(req: Request, url: URL): string | null {
  const q = url.searchParams.get("tenant")?.trim();
  if (q) return q;

  const hTenant = req.headers.get("x-tenant")?.trim();
  if (hTenant) return hTenant;

  const hSolai = req.headers.get("x-solai-tenant")?.trim();
  if (hSolai) return hSolai;

  const m = url.pathname.match(/^\/(?:api\/)?widget\/(?:tenant|config)\/([^/?#]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]).trim();

  return null;
}

function resolveTenantAllowedOrigins(cfg: TenantConfig | undefined, env: Env): Set<string> {
  const allowed = new Set((cfg?.allowed_origins ?? []).map((x) => x.trim()).filter(Boolean));
  const envOrigins = env.WIDGET_ALLOWED_ORIGINS?.split(",").map((x) => x.trim()).filter(Boolean) ?? [];
  for (const origin of envOrigins) allowed.add(origin);
  return allowed;
}

function isOriginAllowedForTenant(origin: string, cfg: TenantConfig | undefined, env: Env) {
  const allowed = resolveTenantAllowedOrigins(cfg, env);
  if (allowed.has(origin)) return true;

  if ((env.ENVIRONMENT ?? "").toLowerCase() === "dev" && DEV_ORIGINS.has(origin)) return true;

  return false;
}

function corsBaseHeaders(): HeadersInit {
  return {
    Vary: "Origin",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
  };
}

function withCorsEnv(req: Request, env: Env, res: Response) {
  const h = new Headers(res.headers);
  const url = new URL(req.url);
  const origin = req.headers.get("Origin")?.trim();
  const pathname = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";

  for (const [k, v] of Object.entries(corsBaseHeaders())) h.set(k, v as string);

  if (origin && isWidgetPath(pathname)) {
    const tenant = getTenantForCors(req, url);
    const cfg = tenant ? TENANTS[tenant] : undefined;
    if (isOriginAllowedForTenant(origin, cfg, env)) {
      h.set("Access-Control-Allow-Origin", origin);
      h.set("Access-Control-Allow-Credentials", "true");
    }
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function getTenant(url: URL): string | null {
  const m = url.pathname.match(/^\/(?:api\/)?widget\/(tenant|config)\/(.+)$/);
  if (m?.[2]) return decodeURIComponent(m[2]).trim();

  const q = url.searchParams.get("tenant");
  if (q) return q.trim();

  return null;
}

async function getTenantFromReq(req: Request, url: URL): Promise<string | null> {
  const q = url.searchParams.get("tenant");
  if (q) return q.trim();

  if (req.method !== "GET") {
    try {
      const body: any = await req.clone().json();
      if (body?.tenant) return String(body.tenant).trim();
    } catch {
      // ignore
    }
  }

  return null;
}

function getClientIp(req: Request) {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    (globalThis as any).SOLAI_TENANT_KILL_SWITCH = env.TENANT_KILL_SWITCH || "";
    const url = new URL(req.url);
    const pathname = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";
    const widgetRoute = isWidgetPath(pathname);
    const origin = req.headers.get("Origin")?.trim();

    if (widgetRoute && origin) {
      const tenantForCors = getTenantForCors(req, url);
      const cfgForCors = tenantForCors ? TENANTS[tenantForCors] : undefined;
      const allowed = !!tenantForCors && isOriginAllowedForTenant(origin, cfgForCors, env);

      if (req.method === "OPTIONS") {
        if (!allowed) {
          return withCorsEnv(req, env, json({ error: "cors_origin_not_allowed" }, 403));
        }
        return withCorsEnv(req, env, new Response(null, { status: 204 }));
      }

      if (!allowed && (req.method === "GET" || req.method === "POST")) {
        return withCorsEnv(req, env, json({ error: "cors_origin_not_allowed" }, 403));
      }
    } else if (req.method === "OPTIONS") {
      return withCorsEnv(req, env, new Response(null, { status: 204 }));
    }

    if (pathname === "/health") {
      return withCorsEnv(req, env, json({ status: "ok", hasElevenKey: !!env.ELEVENLABS_API_KEY }));
    }

    const toolRouteMatch = pathname.match(/^\/(?:api\/)?tool\/([a-zA-Z0-9_-]+)$/);
    if (toolRouteMatch && req.method === "POST") {
      const traceId = traceIdFromReq(req);
      const toolName = decodeURIComponent(toolRouteMatch[1]);
      const sessionId = req.headers.get("x-session-id")?.trim() ?? "";
      const tenantId = req.headers.get("x-tenant-id")?.trim() ?? "";
      const idempotencyKey = req.headers.get("x-idempotency-key")?.trim() ?? "";
      const turnIdHeader = req.headers.get("x-turn-id")?.trim() ?? "";
      const ip = getClientIp(req);

      const body = (await req.json().catch(() => ({}))) as {
        payload?: Record<string, unknown>;
        turn_id?: string;
      };
      const turnId = (body.turn_id ?? turnIdHeader ?? "").trim();

      if (!idempotencyKey || !sessionId || !tenantId || !turnId) {
        return withCorsEnv(req, env, json({ error: "missing_headers", message: "Required: x-session-id, x-tenant-id, x-idempotency-key, x-turn-id", trace_id: traceId }, 400));
      }

      const guard = enforceToolGuardrails({
        traceId,
        sessionId,
        tenantId,
        ip,
        idempotencyKey,
        turnId,
        toolName,
      });

      if (!guard.ok) {
        logTrace("tool.blocked", traceId, { tenant_id: tenantId, session_id: sessionId, code: guard.code });
        return withCorsEnv(req, env, json({ error: guard.code, message: guard.message, retry_after_s: guard.retry_after_s, trace_id: traceId }, guard.status));
      }

      if (!env.N8N_TOOL_BASE_URL) {
        return withCorsEnv(req, env, json({ error: "tool_proxy_not_configured", trace_id: traceId }, 503));
      }

      const upstream = `${env.N8N_TOOL_BASE_URL.replace(/\/+$/, "")}/${encodeURIComponent(toolName)}`;
      const upstreamRes = await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-trace-id": traceId,
          "x-idempotency-key": idempotencyKey,
          "x-session-id": sessionId,
          "x-tenant-id": tenantId,
          "x-turn-id": turnId,
        },
        body: JSON.stringify({ payload: body.payload ?? {}, turn_id: turnId }),
      });

      const payload = await upstreamRes.text();
      logTrace("tool.forward", traceId, { tenant_id: tenantId, session_id: sessionId, tool: toolName, status: upstreamRes.status });

      return withCorsEnv(
        req,
        env,
        new Response(payload, {
          status: upstreamRes.status,
          headers: {
            "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json",
            "x-trace-id": traceId,
          },
        })
      );
    }

    const isSessionRoute = /^\/(?:api\/)?widget\/session$/.test(pathname);
    const isMessageRoute = /^\/(?:api\/)?widget\/message$/.test(pathname);
    const isResetRoute = /^\/(?:api\/)?widget\/reset$/.test(pathname);

    if (isSessionRoute && (req.method === "GET" || req.method === "POST")) {
      const tenant = await getTenantFromReq(req, url);
      if (!tenant) return withCorsEnv(req, env, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCorsEnv(req, env, json({ error: "Invalid tenant" }, 404));

      if (!env.ELEVENLABS_API_KEY) {
        return withCorsEnv(req, env, json({ error: "Missing ELEVENLABS_API_KEY" }, 500));
      }

      const r = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(cfg.agentId)}`,
        {
          method: "GET",
          headers: {
            "xi-api-key": env.ELEVENLABS_API_KEY,
          },
        }
      );

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        return withCorsEnv(
          req,
          env,
          json(
            {
              error: "Failed to get signed url from ElevenLabs",
              status: r.status,
              detail: txt.slice(0, 300),
            },
            502
          )
        );
      }

      const data = (await r.json()) as { signed_url?: string };
      const signedUrl = data?.signed_url;
      if (!signedUrl) {
        return withCorsEnv(req, env, json({ error: "ElevenLabs response missing signed_url" }, 502));
      }

      const tz = "Europe/Madrid";
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, "0");

      const gmtOffsetToIso = (gmt: string) => {
        const m = gmt.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
        if (!m) return "Z";
        const sign = m[1];
        const hh = pad2(parseInt(m[2], 10));
        const mm = pad2(parseInt(m[3] || "0", 10));
        return `${sign}${hh}:${mm}`;
      };

      const now_iso = (() => {
        const dtf = new Intl.DateTimeFormat("en-GB", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZoneName: "shortOffset",
        });

        const parts = dtf.formatToParts(now);
        const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

        const year = get("year");
        const month = get("month");
        const day = get("day");
        const hour = get("hour");
        const minute = get("minute");
        const second = get("second");

        const tzName = get("timeZoneName").replace(/\s/g, "");
        const offset = gmtOffsetToIso(tzName);

        return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
      })();

      const today_human = new Intl.DateTimeFormat("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: tz,
      }).format(now);

      const reqBody = req.method === "POST" ? ((await req.clone().json().catch(() => ({}))) as { client_session_id?: string }) : {};
      const sessionId = reqBody.client_session_id?.trim() || crypto.randomUUID();
      const ttlSeconds = 15 * 60;

      return withCorsEnv(
        req,
        env,
        json({
          tenant,
          session_id: sessionId,
          ttl_seconds: ttlSeconds,
          agentId: cfg.agentId,
          signedUrl,
          branding: cfg.branding,
          dynamic_variables: {
            tz,
            now_iso,
            today_human,
            first_message_mode: "platform_managed",
            allow_agent_first_message: true,
            safe_system_prompt: SAFE_SYSTEM_PROMPT,
            safe_system_prompt_version: "2026-03-05",
            tools_enabled: false,
          },
        })
      );
    }

    if (isMessageRoute && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        session_id?: string;
        text?: string;
        idempotency_key?: string;
      };
      if (!body.session_id || !body.text || !body.idempotency_key) {
        return withCorsEnv(req, env, json({ error: "Missing session_id, text or idempotency_key" }, 400));
      }
      return withCorsEnv(
        req,
        env,
        json(
          {
            error: "not_supported_in_widget_mode",
            message: "Message transport is handled over ElevenLabs websocket in this widget.",
          },
          501
        )
      );
    }

    if (isResetRoute && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { session_id?: string };
      if (!body.session_id) {
        return withCorsEnv(req, env, json({ error: "Missing session_id" }, 400));
      }
      return withCorsEnv(req, env, json({ ok: true, session_id: body.session_id }));
    }

    const isWidgetRoute =
      pathname === "/widget" ||
      pathname === "/api/widget" ||
      pathname.startsWith("/widget/") ||
      pathname.startsWith("/api/widget/");

    if (isWidgetRoute && !isSessionRoute) {
      const tenant = getTenant(url);
      if (!tenant) return withCorsEnv(req, env, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCorsEnv(req, env, json({ error: "Invalid tenant" }, 404));

      return withCorsEnv(req, env, json({ tenant, ...cfg }));
    }

    if (pathname === "/") {
      return withCorsEnv(
        req,
        env,
        json({
          status: "ok",
          endpoints: [
            "/health",
            "/api/tool/:tool",
            "/api/widget/tenant/<tenant>",
            "/api/widget/config/<tenant>",
            "/api/widget/tenant?tenant=<tenant>",
            "/api/widget/config?tenant=<tenant>",
            "/api/widget/session?tenant=<tenant>",
            "/widget/session?tenant=<tenant>",
            "/widget/tenant/<tenant>",
            "/widget/config/<tenant>",
            "/widget/tenant?tenant=<tenant>",
            "/widget/config?tenant=<tenant>",
            "/widget?tenant=<tenant>",
            "/api/widget?tenant=<tenant>",
            "/widget/session",
            "/api/widget/session",
            "/widget/message",
            "/api/widget/message",
            "/widget/reset",
            "/api/widget/reset",
            "/widget",
            "/api/widget",
          ],
          tenants: Object.keys(TENANTS),
        })
      );
    }

    return withCorsEnv(req, env, json({ error: "Not found" }, 404));
  },
};
