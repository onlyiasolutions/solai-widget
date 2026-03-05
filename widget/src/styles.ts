/**
 * SolAI Widget - Estilos premium SaaS
 * Acento azul fijo #2563EB (override solo con data-primary-color explícito)
 * Sin branding/tenant para colores
 */
export function getStyles(primaryColor: string): string {
  const primary = primaryColor || "#2563EB";
  return `
<style>
:host, .solai-widget-wrap {
  /* Sistema de variables - azul premium por defecto */
  --solai-primary: ${primary};
  --solai-primary-hover: #1D4ED8;
  --solai-primary-active: #1E40AF;
  --solai-primary-soft: #EFF6FF;
  --solai-shadow-tint: rgba(37,99,235,0.15);

  --solai-bg: #ffffff;
  --solai-border: #E5E7EB;
  --solai-text: #111827;
  --solai-muted: #9CA3AF;
  --solai-bubble-user: var(--solai-primary);
  --solai-bubble-agent: #F3F4F6;
  --solai-accent: #3B82F6;

  /* Widget glass tokens personalizables */
  --widget-accent: var(--solai-accent);
  --widget-halo-strength: 0.34;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  font-size: 14px;
  box-sizing: border-box;
}

.solai-widget-wrap {
  position: fixed;
  z-index: 2147483647;
}
.solai-widget-wrap.pos-br { bottom: 20px; right: 20px; }
.solai-widget-wrap.pos-bl { bottom: 20px; left: 20px; }
.solai-widget-wrap.pos-tr { top: 20px; right: 20px; }
.solai-widget-wrap.pos-tl { top: 20px; left: 20px; }

/* Botón flotante */
.solai-btn-toggle {
  position: relative;
  z-index: 2;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--solai-primary);
  color: white;
  cursor: pointer;
  box-shadow: 0 10px 25px var(--solai-shadow-tint);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 180ms cubic-bezier(.4,0,.2,1), box-shadow 180ms cubic-bezier(.4,0,.2,1), background 180ms ease;
}
.solai-btn-toggle .solai-icon {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  inset: 0;
  transition: opacity 220ms cubic-bezier(.16,1,.3,1), transform 220ms cubic-bezier(.16,1,.3,1);
}
.solai-btn-toggle .solai-icon-chat {
  opacity: 1;
  transform: scale(1) rotate(0deg);
}
.solai-btn-toggle .solai-icon-chevron {
  opacity: 0;
  transform: scale(0.9) rotate(-90deg);
}
.solai-btn-toggle.open .solai-icon-chat {
  opacity: 0;
  transform: scale(0.9) rotate(-10deg);
}
.solai-btn-toggle.open .solai-icon-chevron {
  opacity: 1;
  transform: scale(1) rotate(0deg);
}
.solai-btn-toggle:hover {
  transform: translateY(-2px);
  box-shadow: 0 14px 32px rgba(37,99,235,0.3);
  background: var(--solai-primary-hover);
}
.solai-btn-toggle:active { transform: scale(0.96); }
.solai-btn-toggle.open { transform: scale(0.96); }

/* Shell: capa exclusiva para halo blur */
.solai-chat-shell{
  position: absolute;
  z-index: 1;
  width: 384px;
  max-width: calc(100vw - 40px);
  height: 520px;
  max-height: calc(100vh - 100px);
  border-radius: 28px;
  isolation: isolate;
  overflow: visible;
  background: transparent !important;
}

.solai-chat-shell::before{
  content: none !important;
  display: none !important;
}

.solai-chat-shell::after{
  content:"";
  position:absolute;
  inset: -28px;
  border-radius: 40px;
  pointer-events:none;
  z-index:-2;
  opacity: 0;
  background: radial-gradient(68% 68% at 50% 50%, color-mix(in srgb, var(--widget-accent) 28%, transparent), rgba(59,130,246,0) 74%);
  filter: blur(24px);
  box-shadow:
    0 0 44px color-mix(in srgb, var(--widget-accent) 24%, transparent),
    0 0 18px color-mix(in srgb, var(--widget-accent) 18%, transparent);
  transition: opacity 220ms cubic-bezier(.16,1,.3,1);
}

.solai-chat-shell.is-open::before,
.solai-chat-shell.is-open::after {
  opacity: 1;
}

/* Panel */
.solai-panel,
.solai-chat-panel {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  isolation: isolate;
  background: rgba(255, 255, 255, 0.96);
  border-radius: 28px;
  box-shadow:
    0 24px 80px rgba(15, 23, 42, 0.20),
    0 2px 10px rgba(15, 23, 42, 0.10);
  border: 1px solid rgba(255, 255, 255, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
  opacity: 0;
  transform: translateY(20px) scale(0.95);
  pointer-events: none;
  transition: opacity 220ms cubic-bezier(.16,1,.3,1), transform 220ms cubic-bezier(.16,1,.3,1);
}

/* Kill switch: el panel no debe dibujar ninguna placa extra detrás */
.solai-chat-panel::before,
.solai-chat-panel::after{
  content: none !important;
  display: none !important;
}
.solai-chat-panel{
  background: rgba(255,255,255,0.96) !important;
}
.solai-panel.solai-panel-open {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.solai-panel.solai-panel-closing {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
  pointer-events: none;
}

.solai-widget-wrap.pos-br .solai-chat-shell,
.solai-widget-wrap.pos-tr .solai-chat-shell { right: 0; bottom: 72px; }
.solai-widget-wrap.pos-bl .solai-chat-shell,
.solai-widget-wrap.pos-tl .solai-chat-shell { left: 0; bottom: 72px; }
.solai-widget-wrap.pos-tr .solai-chat-shell,
.solai-widget-wrap.pos-tl .solai-chat-shell { bottom: auto; top: 72px; }

/* Asegura que el launcher siempre quede por encima */
.solai-btn-toggle { z-index: 2; }

/* Header */
.solai-panel-header {
  height: 56px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  background: var(--solai-bg);
}
.solai-panel-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.solai-panel-logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
  flex-shrink: 0;
}
.solai-panel-title { font-weight: 600; font-size: 15px; color: var(--solai-text); }
.solai-btn-close {
  width: 36px; height: 36px;
  border: none; background: transparent;
  color: var(--solai-muted); font-size: 20px;
  cursor: pointer; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  margin-right: -10px;
  transition: color 180ms ease, background 180ms ease;
}
.solai-btn-close:hover { color: var(--solai-text); background: #F3F4F6; }

/* Vista chat (oculta en modo llamada) */
.solai-chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: opacity 200ms ease;
}
.solai-panel.view-call .solai-chat-view {
  display: none;
}

/* Interior del chat nítido (sin tinte/blur) */
.solai-chat-panel > * {
  position: relative;
  z-index: 1;
}
.solai-chat-panel .solai-chat-view,
.solai-chat-panel .solai-chat-wrap,
.solai-chat-panel .solai-chat,
.solai-chat-panel .solai-panel-header,
.solai-chat-panel .solai-input-row {
  background: transparent;
}

/* Call screen (solo visible en modo llamada) */
.solai-call-view {
  flex: 1;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: #FAFBFC;
  transition: opacity 200ms ease;
}
.solai-panel.view-call .solai-call-view {
  display: flex;
}

.solai-call-status {
  font-size: 13px;
  color: var(--solai-muted);
  margin-bottom: 24px;
}

.solai-call-btn-wrap {
  position: relative;
}

.solai-call-btn {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  border: none;
  background: var(--solai-primary);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(37,99,235,0.25);
  transition: background 180ms ease, transform 100ms ease;
}
.solai-call-btn:hover {
  background: #EF4444;
}
.solai-call-btn svg {
  width: 32px;
  height: 32px;
}

/* Área chat */
.solai-chat-wrap {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.solai-chat {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.solai-chat-empty {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  color: var(--solai-muted);
  font-size: 14px;
  pointer-events: none;
}

/* Burbujas */
.solai-bubble {
  max-width: 85%;
  padding: 12px 16px;
  border-radius: 18px;
  word-wrap: break-word;
  line-height: 1.45;
  animation: solai-bubble-in 180ms cubic-bezier(.16,1,.3,1) forwards;
  opacity: 0;
  transform: translateY(8px);
}
@keyframes solai-bubble-in {
  to { opacity: 1; transform: translateY(0); }
}
.solai-bubble-user {
  align-self: flex-end;
  background: var(--solai-bubble-user);
  color: white;
  border-bottom-right-radius: 4px;
}
.solai-bubble-agent {
  align-self: flex-start;
  background: var(--solai-bubble-agent);
  color: var(--solai-text);
  border-bottom-left-radius: 4px;
}

/* Input + botones (ocultos en call) */
.solai-input-row {
  display: flex;
  gap: 10px;
  padding: 20px;
  flex-shrink: 0;
}
.solai-panel.view-call .solai-input-row {
  display: none;
}
.solai-input-row-voice { justify-content: center; }

.solai-input {
  flex: 1; min-width: 0;
  padding: 12px 18px;
  border: 1px solid var(--solai-border);
  border-radius: 999px;
  font-size: 14px; outline: none;
  background: #F9FAFB;
  transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
}
.solai-input:focus {
  border-color: var(--solai-primary);
  background: var(--solai-bg);
  box-shadow: 0 0 0 3px var(--solai-primary-soft);
}
.solai-input::placeholder { color: var(--solai-muted); }

.solai-btn-send,
.solai-btn-call {
  width: 44px; height: 44px;
  min-width: 44px; min-height: 44px;
  border-radius: 50%;
  border: none;
  background: var(--solai-primary);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 180ms ease, transform 150ms ease;
}
.solai-btn-send:hover,
.solai-btn-call:hover { background: var(--solai-primary-hover); }
.solai-btn-send:active,
.solai-btn-call:active { transform: scale(0.95); }
.solai-btn-send { font-size: 18px; font-weight: 600; }

.solai-btn-call.solai-call-active {
  background: #EF4444;
}
.solai-btn-call.solai-call-active:hover {
  background: #DC2626;
}

.solai-input-row-voice .solai-btn-call {
  width: 52px; height: 52px;
  min-width: 52px; min-height: 52px;
}

@media (prefers-reduced-motion: reduce) {
  .solai-chat-shell::before,
  .solai-chat-shell::after,
  .solai-panel,
  .solai-btn-toggle {
    transition: none;
  }
}

</style>
`;
}
