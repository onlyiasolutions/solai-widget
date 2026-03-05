import tenants from "../tenants.json";
import { enforceToolGuardrails } from "./tool-gateway";
import { logTrace, traceIdFromReq } from "./telemetry";

type Branding = { name: string; primaryColor: string; logoUrl?: string };
type TenantConfig = { agentId: string; branding: Branding };
type TenantsMap = Record<string, TenantConfig>;

export interface Env {
  ELEVENLABS_API_KEY?: string;
  N8N_TOOL_BASE_URL?: string;
  TENANT_KILL_SWITCH?: string;
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

function corsHeaders(req: Request): HeadersInit {
  const originHeader = req.headers.get("Origin");
  const allowOrigin = originHeader || "*";

  const reqHeaders = req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization";
  const reqMethod = req.headers.get("Access-Control-Request-Method") || "GET,POST,OPTIONS";

  const headers: HeadersInit = {
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Allow-Methods": reqMethod,
  };

  if (originHeader) {
    (headers as Record<string, string>)["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

function withCors(req: Request, res: Response) {
  const h = new Headers(res.headers);
  const ch = corsHeaders(req);
  for (const [k, v] of Object.entries(ch)) h.set(k, v as string);
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
      const body: any = await req.json();
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

    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }

    const url = new URL(req.url);
    const pathname = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";

    if (pathname === "/health") {
      return withCors(req, json({ status: "ok", hasElevenKey: !!env.ELEVENLABS_API_KEY }));
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
        return withCors(req, json({ error: "missing_headers", message: "Required: x-session-id, x-tenant-id, x-idempotency-key, x-turn-id", trace_id: traceId }, 400));
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
        return withCors(req, json({ error: guard.code, message: guard.message, retry_after_s: guard.retry_after_s, trace_id: traceId }, guard.status));
      }

      if (!env.N8N_TOOL_BASE_URL) {
        return withCors(req, json({ error: "tool_proxy_not_configured", trace_id: traceId }, 503));
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

      return withCors(
        req,
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

    if (isSessionRoute) {
      const tenant = await getTenantFromReq(req, url);
      if (!tenant) return withCors(req, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCors(req, json({ error: "Invalid tenant" }, 400));

      if (!env.ELEVENLABS_API_KEY) {
        return withCors(req, json({ error: "Missing ELEVENLABS_API_KEY" }, 500));
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
        return withCors(
          req,
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
        return withCors(req, json({ error: "ElevenLabs response missing signed_url" }, 502));
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

      return withCors(
        req,
        json({
          signedUrl,
          dynamic_variables: {
            tz,
            now_iso,
            today_human,
            first_message_mode: "greet_only",
            tools_enabled: false,
          },
        })
      );
    }

    const isWidgetRoute =
      pathname === "/widget" ||
      pathname === "/api/widget" ||
      pathname.startsWith("/widget/") ||
      pathname.startsWith("/api/widget/");

    if (isWidgetRoute && !isSessionRoute) {
      const tenant = getTenant(url);
      if (!tenant) return withCors(req, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCors(req, json({ error: "Invalid tenant" }, 400));

      return withCors(req, json({ tenant, ...cfg }));
    }

    if (pathname === "/") {
      return withCors(
        req,
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
            "/widget",
            "/api/widget",
          ],
          tenants: Object.keys(TENANTS),
        })
      );
    }

    return withCors(req, json({ error: "Not found" }, 404));
  },
};
