import { Router, Request, Response } from "express";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
    // Si algo falla en el rate limit, no bloqueamos la petición
  }

  const tenant = req.query.tenant as string;

  if (!tenant) {
    res.status(400).json({ error: "Missing tenant parameter" });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server configuration error: ELEVENLABS_API_KEY not set" });
    return;
  }

  let tenants: Record<string, TenantConfig>;
  try {
    tenants = await loadTenants();
  } catch (e) {
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

  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;

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

    res.json({
      tenant,
      agentId,
      signedUrl,
      branding: config.branding,
    });
  } catch (e) {
    console.error("[widget] Error fetching signed URL:", e);
    res.status(502).json({ error: "Failed to connect to ElevenLabs" });
  }
});
