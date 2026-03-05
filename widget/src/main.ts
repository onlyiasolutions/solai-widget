/**
 * SolAI Widget - Entry point
 * Se ejecuta al cargar el script. Lee atributos data-* y monta el widget.
 */
import { SolAIWidget, type WidgetConfig } from "./widget";

const DEFAULT_WIDGET_API_BASE = "https://solai-widget-api.wesolailabs.workers.dev";

declare global {
  interface Window {
    SOLA_WIDGET_CONFIG?: Partial<{ tenant: string; apiBase: string; position: string; mode: string; primaryColor: string; sessionTtlMinutes?: number; firstMessageMode?: "greet_only" | "platform_managed" }>;
    __SOLAI_WIDGET_MOUNTED__?: boolean;
  }
}

function getScriptElement(): HTMLScriptElement | null {
  const scripts = document.querySelectorAll('script[src*="solai-widget"], script[src*="main.ts"]');
  return scripts[scripts.length - 1] as HTMLScriptElement | null;
}

function normalizeBase(input: string): string {
  const raw = String(input || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  return `https://${raw}`;
}

function resolveApiBase(script: HTMLScriptElement | null, global: Window["SOLA_WIDGET_CONFIG"]): string {
  const fromDataAttr = script?.getAttribute("data-api-base")?.trim() ?? "";
  if (fromDataAttr) return normalizeBase(fromDataAttr);

  if (global?.apiBase) return normalizeBase(global.apiBase);

  const fromVite = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_WIDGET_API_BASE;
  if (fromVite) return normalizeBase(fromVite);

  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITE_WIDGET_API_BASE;
  if (fromProcess) return normalizeBase(fromProcess);

  return normalizeBase(DEFAULT_WIDGET_API_BASE);
}

function getConfig(): WidgetConfig {
  const global = typeof window !== "undefined" ? window.SOLA_WIDGET_CONFIG : undefined;
  const script = getScriptElement();
  const base = resolveApiBase(script, global);
  const pos = global?.position ?? script?.getAttribute("data-position") ?? "br";
  const mode = global?.mode ?? script?.getAttribute("data-mode") ?? "voice+chat";
  return {
    tenant: global?.tenant ?? script?.getAttribute("data-tenant") ?? "demo-dental",
    apiBase: base,
    position: (["br", "bl", "tr", "tl"].includes(pos) ? pos : "br") as "br" | "bl" | "tr" | "tl",
    mode: (["chat", "voice", "voice+chat"].includes(mode) ? mode : "voice+chat") as "chat" | "voice" | "voice+chat",
    primaryColor: (script?.hasAttribute("data-primary-color") ? script.getAttribute("data-primary-color") : null) || "#2563EB",
    sessionTtlMinutes: (() => {
      const attr = script?.getAttribute("data-session-ttl-minutes");
      const n = attr != null ? parseInt(attr, 10) : (global as { sessionTtlMinutes?: number })?.sessionTtlMinutes ?? 10;
      return isNaN(n) || n <= 0 ? 10 : n;
    })(),
    firstMessageMode:
      global?.firstMessageMode ??
      ((script?.getAttribute("data-first-message-mode") as "greet_only" | "platform_managed" | null) ?? "platform_managed"),
  };
}

// Montar widget cuando el DOM esté listo
function init() {
  if (typeof window !== "undefined" && window.__SOLAI_WIDGET_MOUNTED__) {
    return;
  }
  const config = getConfig();
  const widget = new SolAIWidget(config);
  widget.mount();
  if (typeof window !== "undefined") {
    window.__SOLAI_WIDGET_MOUNTED__ = true;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
