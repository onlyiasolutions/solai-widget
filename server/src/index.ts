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

async function getTenantFromReq(req: Request, url: URL): Promise<string | null> {
  const q = url.searchParams.get("tenant");
  if (q) return q.trim();

  // If not provided via querystring, try JSON body (POST/PUT/etc.)
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

    // Session (returns { signedUrl })
    // Use a regex match to avoid any edge cases with trailing slashes or future prefixes.
    const isSessionRoute = /^\/(?:api\/)?widget\/session$/.test(pathname);

    if (isSessionRoute) {
      const tenant = await getTenantFromReq(req, url);
      if (!tenant) return withCors(req, json({ error: "Missing tenant" }, 400));

      const cfg = TENANTS[tenant];
      if (!cfg) return withCors(req, json({ error: "Invalid tenant" }, 400));

      if (!env.ELEVENLABS_API_KEY) {
        return withCors(req, json({ error: "Missing ELEVENLABS_API_KEY" }, 500));
      }

      // ElevenLabs: signed URL for the agent
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

      // Build an ISO string that reflects the provided IANA timezone (e.g. Europe/Madrid),
      // including the correct UTC offset (e.g. 2026-02-25T18:29:11+01:00).
      const pad2 = (n: number) => String(n).padStart(2, "0");

      const gmtOffsetToIso = (gmt: string) => {
        // Examples seen in the wild: "GMT+1", "GMT+01:00", "UTC+1", "UTC+01:00"
        const m = gmt.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
        if (!m) return "Z";
        const sign = m[1];
        const hh = pad2(parseInt(m[2], 10));
        const mm = pad2(parseInt(m[3] || "0", 10));
        return `${sign}${hh}:${mm}`;
      };

      const now_iso = (() => {
        // We format parts in the target timezone and then append the timezone offset.
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

        // In most runtimes this comes as "GMT+1" / "UTC+1" / "GMT+01:00" etc.
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
          },
        })
      );
    }

    // Tenant config
    // Accept both the base path ("/widget" or "/api/widget") and subpaths ("/widget/..." or "/api/widget/...")
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