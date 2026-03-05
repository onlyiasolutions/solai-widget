import { Router, Request, Response } from "express";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SAFE_SYSTEM_PROMPT } from "../safety-system-prompt";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TenantConfig = {
  agentId: string;
  branding: {
    name: string;
    primaryColor?: string;
    logoUrl?: string;
  };
};

// In-memory rate limit: IP -> array of timestamps (ms) for /session
const sessionRateLimitMap = new Map<string, number[]>();

let tenantsCache: Record<string, TenantConfig> | null = null;

async function loadTenants(): Promise<Record<string, TenantConfig>> {
  if (tenantsCache) return tenantsCache;
  const path = join(__dirname, "..", "..", "tenants.json");
  const raw = await readFile(path, "utf-8");
  tenantsCache = JSON.parse(raw) as Record<string, TenantConfig>;
  return tenantsCache;
}

const TZ = "Europe/Madrid";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function offsetFromTZ(now: Date, timeZone: string): string {
  // Node moderno soporta "shortOffset" y devuelve algo tipo "GMT+1" / "GMT+02:00"
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);

  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";

  // tzName: "GMT+1" | "GMT+01:00" | "GMT-3" ...
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return "+00:00";

  const sign = m[1] === "-" ? "-" : "+";
  const hh = pad2(parseInt(m[2], 10));
  const mm = pad2(m[3] ? parseInt(m[3], 10) : 0);
  return `${sign}${hh}:${mm}`;
}

function nowIsoInTZ(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");
  const ss = get("second");

  const offset = offsetFromTZ(now, timeZone);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${offset}`;
}

function todayHuman(now: Date, timeZone: string): string {
  // Ej: "miércoles, 25 de febrero de 2026"
  const s = new Intl.DateTimeFormat("es-ES", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  // Quitamos coma para que sea más natural en prompt si quieres
  return s.replace(",", "");
}

export const widgetRouter = Router();

widgetRouter.get("/session", async (req: Request, res: Response) => {
  // Basic per-IP rate limiting: max 10 requests/minute
  try {
    const ip =
      (req.headers["cf-connecting-ip"] as string | undefined) ||
      req.ip ||
      req.connection.remoteAddress ||
      "unknown";

    const now = Date.now();
    const prev = sessionRateLimitMap.get(ip) ?? [];
    const recent = prev.filter((t) => now - t < 60_000);

    if (recent.length >= 10) {
      res.status(429).json({
        error: "rate_limited",
        message: "Too many session requests",
      });
      return;
    }

    recent.push(now);
    sessionRateLimitMap.set(ip, recent);
  } catch {
    // no bloqueamos si falla rate limit
  }

  const tenant = req.query.tenant as string;

  if (!tenant) {
    res.status(400).json({ error: "Missing tenant parameter" });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res
      .status(500)
      .json({ error: "Server configuration error: ELEVENLABS_API_KEY not set" });
    return;
  }

  let tenants: Record<string, TenantConfig>;
  try {
    tenants = await loadTenants();
  } catch {
    res.status(500).json({ error: "Failed to load tenant configuration" });
    return;
  }

  const config = tenants[tenant];
  if (!config) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const agentId = config.agentId;
  if (!agentId || agentId.startsWith("REPLACE_") || agentId.startsWith("your_")) {
    res.status(500).json({
      error: "Agent not configured",
      hint: `Configure agentId in server/tenants.json for tenant "${tenant}"`,
    });
    return;
  }

  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
    agentId
  )}`;

  try {
    const response = await fetch(url, {
      headers: { "xi-api-key": apiKey },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("[widget] ElevenLabs API error:", response.status, text);
      res.status(502).json({
        error: "Failed to get signed URL from ElevenLabs",
        detail: response.status === 401 ? "Invalid ELEVENLABS_API_KEY" : undefined,
      });
      return;
    }

    const body = (await response.json()) as { signed_url?: string };
    const signedUrl = body.signed_url;

    if (!signedUrl) {
      res.status(502).json({ error: "Invalid response from ElevenLabs" });
      return;
    }

    // ✅ Dynamic variables que ElevenLabs te está pidiendo
    const now = new Date();
    const dynamic_variables = {
      tz: TZ,
      now_iso: nowIsoInTZ(now, TZ),
      today_human: todayHuman(now, TZ),
      first_message_mode: "platform_managed",
      allow_agent_first_message: true,
      safe_system_prompt: SAFE_SYSTEM_PROMPT,
      safe_system_prompt_version: "2026-03-05",
    };

    res.json({
      tenant,
      agentId,
      signedUrl,
      branding: config.branding,
      dynamic_variables, // <-- CLAVE
    });
  } catch (e) {
    console.error("[widget] Error fetching signed URL:", e);
    res.status(502).json({ error: "Failed to connect to ElevenLabs" });
  }
});
