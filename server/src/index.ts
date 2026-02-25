import tenants from "../tenants.json";

type Branding = { name: string; primaryColor: string; logoUrl?: string };
type TenantConfig = { agentId: string; branding: Branding };
type TenantsMap = Record<string, TenantConfig>;

export interface Env {
  // Optional, but allows /health to report if it's configured.
  ELEVENLABS_API_KEY?: string;
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

  const reqHeaders =
    req.headers.get("Access-Control-Request-Headers") ||
    "Content-Type, Authorization";
  const reqMethod =
    req.headers.get("Access-Control-Request-Method") || "GET,POST,OPTIONS";

  const headers: HeadersInit = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Allow-Methods": reqMethod,
  };

  // Only allow credentials when we echo back a specific Origin.
  if (originHeader) {
    (headers as Record<string, string>)["Access-Control-Allow-Credentials"] =
      "true";
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
  // Supports:
  // - /api/widget/tenant/<tenant>
  // - /api/widget/config/<tenant>
  // - /widget/tenant/<tenant>
  // - /widget/config/<tenant>
  // - /api/widget/tenant?tenant=<tenant>
  // - /api/widget/config?tenant=<tenant>
  // - /widget/tenant?tenant=<tenant>
  // - /widget/config?tenant=<tenant>
  const m = url.pathname.match(/^\/(?:api\/)?widget\/(tenant|config)\/(.+)$/);
  if (m?.[2]) return decodeURIComponent(m[2]).trim();

  const q = url.searchParams.get("tenant");
  if (q) return q.trim();

  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Preflight
    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }

    const url = new URL(req.url);

    // Normalize trailing slash (except for root)
    const pathname = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";

    // Health
    if (pathname === "/health") {
      return withCors(req, json({ status: "ok", hasElevenKey: !!env.ELEVENLABS_API_KEY }));
    }

    // Tenant config
    // Accept both the base path ("/widget" or "/api/widget") and subpaths ("/widget/..." or "/api/widget/...")
    const isWidgetRoute =
      pathname === "/widget" ||
      pathname === "/api/widget" ||
      pathname.startsWith("/widget/") ||
      pathname.startsWith("/api/widget/");

    if (isWidgetRoute) {
      const tenant = getTenant(url);
      if (!tenant) return withCors(req, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCors(req, json({ error: "Invalid tenant" }, 400));

      return withCors(req, json({ tenant, ...cfg }));
    }

    // Root (debug-friendly)
    if (pathname === "/") {
      return withCors(
        req,
        json({
          status: "ok",
          endpoints: [
            "/health",
            "/api/widget/tenant/<tenant>",
            "/api/widget/config/<tenant>",
            "/api/widget/tenant?tenant=<tenant>",
            "/api/widget/config?tenant=<tenant>",
            "/widget/tenant/<tenant>",
            "/widget/config/<tenant>",
            "/widget/tenant?tenant=<tenant>",
            "/widget/config?tenant=<tenant>",
            "/widget?tenant=<tenant>",
            "/api/widget?tenant=<tenant>",
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