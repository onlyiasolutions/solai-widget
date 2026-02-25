/**
 * SolAI Widget - Entry point
 * Se ejecuta al cargar el script. Lee atributos data-* y monta el widget.
 */
import { SolAIWidget, type WidgetConfig } from "./widget";

declare global {
  interface Window {
    SOLA_WIDGET_CONFIG?: Partial<{ tenant: string; apiBase: string; position: string; mode: string; primaryColor: string; sessionTtlMinutes?: number }>;
    __SOLAI_WIDGET_MOUNTED__?: boolean;
  }
}

function getScriptElement(): HTMLScriptElement | null {
  const scripts = document.querySelectorAll('script[src*="solai-widget"], script[src*="main.ts"]');
  return scripts[scripts.length - 1] as HTMLScriptElement | null;
}

function getConfig(): WidgetConfig {
  const global = typeof window !== "undefined" ? window.SOLA_WIDGET_CONFIG : undefined;
  const script = getScriptElement();
  const base = typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "";
  const pos = global?.position ?? script?.getAttribute("data-position") ?? "br";
  const mode = global?.mode ?? script?.getAttribute("data-mode") ?? "voice+chat";
  return {
    tenant: global?.tenant ?? script?.getAttribute("data-tenant") ?? "demo-dental",
    apiBase: global?.apiBase ?? script?.getAttribute("data-api-base") ?? base,
    position: (["br", "bl", "tr", "tl"].includes(pos) ? pos : "br") as "br" | "bl" | "tr" | "tl",
    mode: (["chat", "voice", "voice+chat"].includes(mode) ? mode : "voice+chat") as "chat" | "voice" | "voice+chat",
    primaryColor: (script?.hasAttribute("data-primary-color") ? script.getAttribute("data-primary-color") : null) || "#2563EB",
    sessionTtlMinutes: (() => {
      const attr = script?.getAttribute("data-session-ttl-minutes");
      const n = attr != null ? parseInt(attr, 10) : (global as { sessionTtlMinutes?: number })?.sessionTtlMinutes ?? 10;
      return isNaN(n) || n <= 0 ? 10 : n;
    })(),
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
