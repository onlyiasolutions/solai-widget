/**
 * SolAI Widget - Widget principal con Shadow DOM
 * Integración ElevenLabs ElevenAgents (voz + chat) vía Signed URLs
 * Separación clara: TEXT_CHAT (sin mic) vs VOICE_CALL (solo al pulsar mic)
 */
import { Conversation } from "@elevenlabs/client";
import { getStyles } from "./styles";

const DEV = typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1");

const ICON_PHONE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

export type WidgetConfig = {
  tenant: string;
  apiBase: string;
  position: "br" | "bl" | "tr" | "tl";
  mode: "chat" | "voice" | "voice+chat";
  primaryColor: string;
};

export type SessionData = {
  tenant: string;
  agentId: string;
  signedUrl: string;
  branding: { name?: string; primaryColor?: string; logoUrl?: string };
};

export type Message = { role: "user" | "agent"; text: string };
export type WidgetState = "idle" | "connecting" | "typing" | "in_call" | "processing" | "speaking" | "error";

export class SolAIWidget {
  private config: WidgetConfig;
  private root: ShadowRoot | null = null;
  private container: HTMLElement | null = null;
  private button: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private chatContainer: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private sendBtn: HTMLElement | null = null;
  private callBtn: HTMLElement | null = null;
  private closeBtn: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private conversation: Awaited<ReturnType<typeof Conversation.startSession>> | null = null;
  private state: WidgetState = "idle";
  private messages: Message[] = [];
  private callActive = false;
  private micPermissionDenied = false;
  private agentStreamingText = "";
  private responseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly RESPONSE_TIMEOUT_MS = 12_000;

  constructor(config: WidgetConfig) {
    this.config = {
      ...config,
      position: (["br", "bl", "tr", "tl"].includes(config.position) ? config.position : "br") as WidgetConfig["position"],
      mode: (["chat", "voice", "voice+chat"].includes(config.mode) ? config.mode : "voice+chat") as WidgetConfig["mode"],
    };
  }

  mount() {
    const host = document.createElement("div");
    host.id = "solai-widget-host";
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    this.root = shadow;

    shadow.innerHTML = getStyles(this.config.primaryColor);

    const wrap = document.createElement("div");
    wrap.className = "solai-widget-wrap";
    wrap.classList.add(`pos-${this.config.position}`);
    shadow.appendChild(wrap);

    this.container = wrap;

    this.button = document.createElement("button");
    this.button.className = "solai-btn-toggle";
    this.button.setAttribute("aria-label", "Abrir chat");
    this.button.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    `;
    this.button.addEventListener("click", () => this.togglePanel());
    wrap.appendChild(this.button);

    this.panel = document.createElement("div");
    this.panel.className = "solai-panel";
    this.panel.hidden = true;
    const showInput = this.config.mode !== "voice";
    const showCall = this.config.mode !== "chat";
    this.panel.innerHTML = `
      <header class="solai-panel-header">
        <span class="solai-panel-title">Chat</span>
        <button class="solai-btn-close" aria-label="Cerrar">×</button>
      </header>
      <div class="solai-chat-view">
        <div class="solai-chat-wrap">
          <div class="solai-chat" role="log"></div>
          <div class="solai-chat-empty">Escribe un mensaje…</div>
        </div>
        <div class="solai-input-row ${!showInput ? "solai-input-row-voice" : ""}">
          ${showInput ? '<input type="text" class="solai-input" placeholder="Escribe un mensaje…" autocomplete="off" />' : ""}
          ${showInput ? '<button class="solai-btn-send" aria-label="Enviar">↑</button>' : ""}
          ${showCall ? '<button class="solai-btn-call" aria-label="Iniciar llamada">' + ICON_PHONE + '</button>' : ""}
        </div>
        <div class="solai-state" role="status"></div>
      </div>
      ${showCall ? `
      <div class="solai-call-view">
        <div class="solai-call-status">En llamada…</div>
        <div class="solai-call-btn-wrap">
          <button class="solai-call-btn" aria-label="Colgar llamada">${ICON_PHONE}</button>
        </div>
      </div>
      ` : ""}
    `;
    wrap.appendChild(this.panel);

    this.chatContainer = this.panel.querySelector(".solai-chat");
    this.inputEl = this.panel.querySelector(".solai-input");
    this.sendBtn = this.panel.querySelector(".solai-btn-send");
    this.callBtn = this.panel.querySelector(".solai-btn-call");
    this.closeBtn = this.panel.querySelector(".solai-btn-close");
    this.stateEl = this.panel.querySelector(".solai-state");

    const callScreenBtn = this.panel.querySelector(".solai-call-btn");
    if (callScreenBtn) callScreenBtn.addEventListener("click", () => this.toggleCall());

    this.closeBtn?.addEventListener("click", () => this.closePanel());
    this.sendBtn?.addEventListener("click", () => this.sendText());
    this.inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.sendText();
    });

    if (this.callBtn && this.config.mode !== "chat") {
      this.callBtn.addEventListener("click", () => this.toggleCall());
    }

    this.setUIForMode();
  }

  private setUIForMode() {
    if (this.config.mode === "chat" && this.inputEl) {
      this.inputEl.placeholder = "Escribe un mensaje...";
    }
  }

  private async togglePanel() {
    if (this.panel?.hidden) {
      this.openPanel();
    } else {
      this.closePanel();
    }
  }

  private openPanel() {
    this.panel!.hidden = false;
    this.panel!.classList.remove("solai-panel-closing");
    this.button?.classList.add("open");
    this.button?.setAttribute("aria-label", "Cerrar chat");
    requestAnimationFrame(() => {
      this.panel?.classList.add("solai-panel-open");
    });
    this.ensureChatSession();
  }

  private closePanel() {
    this.panel?.classList.remove("solai-panel-open");
    this.panel?.classList.add("solai-panel-closing");
    this.button?.classList.remove("open");
    this.button?.setAttribute("aria-label", "Abrir chat");
    setTimeout(() => {
      this.panel!.hidden = true;
      this.panel?.classList.remove("solai-panel-closing");
      this.disconnect();
    }, 220);
  }

  private setState(s: WidgetState) {
    this.state = s;
    const labels: Record<WidgetState, string> = {
      idle: "",
      connecting: "Conectando...",
      typing: "",
      in_call: "En llamada",
      processing: "",
      speaking: "Hablando",
      error: "Error",
    };
    const useTypingDots = s === "idle" || s === "typing" || s === "processing";
    if (this.stateEl) {
      if (useTypingDots) {
        this.stateEl.innerHTML = '<span class="solai-typing-dots"><span></span><span></span><span></span></span>';
      } else {
        this.stateEl.innerHTML = labels[s] ? `<span class="solai-state-text">${labels[s]}</span>` : "";
      }
    }
    this.root?.querySelector(".solai-widget-wrap")?.classList.remove("state-idle", "state-typing", "state-listening", "state-in-call", "state-thinking", "state-processing", "state-speaking", "state-error");
    if (s !== "idle") this.root?.querySelector(".solai-widget-wrap")?.classList.add(`state-${s.replace("_", "-")}`);
    if (DEV) console.log("[SolAI] state:", s, "callActive:", this.callActive);
  }

  private async fetchSession(): Promise<SessionData> {
    const url = `${this.config.apiBase.replace(/\/$/, "")}/api/widget/session?tenant=${encodeURIComponent(this.config.tenant)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Session error: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Asegura sesión de chat activa. NO pide permisos de micrófono.
   * Espera a que la conexión esté ready antes de enviar.
   */
  private async ensureChatSession(): Promise<boolean> {
    if (this.conversation && !this.callActive) return true;

    this.setState("connecting");
    if (DEV) console.log("[SolAI] ensureChatSession: fetching session");

    try {
      const session = await this.fetchSession();
      if (DEV) console.log("[SolAI] session fetched ok");

      /* Título siempre "Chat", sin mostrar branding */

      const conversation = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        textOnly: true,
        onMessage: (msg: { source?: string; type?: string; message?: string }) => {
          if (msg.source === "user" && msg.type === "conversation_initiation_metadata") return;
          const text = (msg as { message?: string }).message;
          if (DEV) console.log("[SolAI] event received: onMessage", msg.source, msg.type);
          if (text) {
            if (msg.source === "agent") {
              this.clearResponseTimeout();
              this.addMessage("agent", text);
              if (DEV) console.log("[SolAI] agent text appended");
              this.setState("idle");
            }
            if (msg.source === "user") this.addMessage("user", text);
          }
        },
        onAgentChatResponsePart: (part: { type?: string; text?: string }) => {
          if (DEV) console.log("[SolAI] event received: onAgentChatResponsePart", part.type);
          if (part.type === "start") this.agentStreamingText = "";
          if (part.text) this.agentStreamingText += part.text;
          if (part.type === "stop") {
            this.clearResponseTimeout();
            if (this.agentStreamingText.trim()) {
              this.addMessage("agent", this.agentStreamingText.trim());
              if (DEV) console.log("[SolAI] agent text appended (stream complete)");
            }
            this.agentStreamingText = "";
            this.setState("idle");
          }
        },
        onStatusChange: (s: { status?: string }) => {
          if (s.status === "connected") {
            if (DEV) console.log("[SolAI] ws connected");
            this.setState("idle");
          }
          if (s.status === "connecting") this.setState("connecting");
          if (s.status === "disconnected") this.setState("idle");
        },
        onError: (err: unknown) => {
          console.error("[SolAI] ElevenLabs error:", err);
          const str = String(err);
          if (str.includes("token") || str.includes("expir")) {
            this.disconnect();
            this.ensureChatSession();
          } else {
            this.clearResponseTimeout();
            this.setState("error");
          }
        },
      });

      this.conversation = conversation;
      this.callActive = false;
      this.setState("idle");
      this.updateCallButton();
      if (DEV) console.log("[SolAI] connectChat: sesión texto activa");
      return true;
    } catch (e) {
      console.error("[SolAI] Connect error:", e);
      this.addMessage("agent", `Error: ${(e as Error).message}. ¿Está el servidor corriendo?`);
      this.setState("error");
      return false;
    }
  }

  private clearResponseTimeout() {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
      this.responseTimeoutId = null;
    }
  }

  private startResponseTimeout() {
    this.clearResponseTimeout();
    this.responseTimeoutId = setTimeout(() => {
      this.responseTimeoutId = null;
      if (this.state === "processing") {
        if (DEV) console.log("[SolAI] response timeout");
        this.addMessage("agent", "No he podido responder ahora, ¿puedes repetir?");
        this.setState("idle");
      }
    }, this.RESPONSE_TIMEOUT_MS);
  }

  /**
   * Conecta en modo LLAMADA (audio). SOLO se llama al pulsar el botón mic.
   * Aquí sí se pide getUserMedia.
   */
  private async connectCall() {
    if (this.callActive && this.conversation) return;

    if (DEV) console.log("[SolAI] connectCall: solicitando micrófono");

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.micPermissionDenied = true;
      this.addMessage("agent", "No se pudo acceder al micrófono. Usa el chat por texto.");
      if (DEV) console.log("[SolAI] connectCall: permiso mic denegado");
      return;
    }

    this.endCurrentSession();

    this.setState("connecting");
    if (DEV) console.log("[SolAI] connectCall: iniciando sesión voz");

    try {
      const session = await this.fetchSession();

      const conversation = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        textOnly: false,
        onMessage: (msg: { source?: string; type?: string; message?: string }) => {
          if (this.callActive) return;
          if (msg.source === "user" && msg.type === "conversation_initiation_metadata") return;
          const text = (msg as { message?: string }).message;
          if (text) {
            if (msg.source === "agent") this.addMessage("agent", text);
            if (msg.source === "user") this.addMessage("user", text);
          }
        },
        onModeChange: (m: { mode?: string }) => {
          if (m.mode === "listening") this.setState("in_call");
          else if (m.mode === "speaking") this.setState("speaking");
        },
        onStatusChange: (s: { status?: string }) => {
          if (s.status === "connected") this.setState("in_call");
          if (s.status === "connecting") this.setState("connecting");
          if (s.status === "disconnected") {
            this.callActive = false;
            this.updateCallButton();
            this.setState("idle");
          }
        },
        onError: (err: unknown) => {
          console.error("[SolAI] ElevenLabs error:", err);
          const str = String(err);
          if (str.includes("token") || str.includes("expir")) {
            this.endCurrentSession();
            this.connectCall();
          } else {
            this.setState("error");
          }
        },
      });

      this.conversation = conversation;
      this.callActive = true;
      this.setState("in_call");
      this.updateCallButton();
      if (DEV) console.log("[SolAI] connectCall: sesión voz activa");
    } catch (e) {
      console.error("[SolAI] Connect error:", e);
      this.addMessage("agent", `Error: ${(e as Error).message}`);
      this.setState("error");
    }
  }

  private endCurrentSession() {
    this.clearResponseTimeout();
    this.stopVolumePulse();
    if (this.conversation) {
      this.conversation.endSession().catch(() => {});
      this.conversation = null;
    }
    this.callActive = false;
    this.updateCallButton();
    if (DEV) console.log("[SolAI] endCurrentSession: sesión cerrada");
  }

  private updateCallButton() {
    if (this.callBtn) {
      if (this.callActive) {
        this.callBtn.setAttribute("aria-label", "Colgar llamada");
        this.callBtn.classList.add("solai-call-active");
      } else {
        this.callBtn.setAttribute("aria-label", "Iniciar llamada");
        this.callBtn.classList.remove("solai-call-active");
      }
    }
    this.panel?.classList.toggle("view-call", this.callActive);
    if (this.callActive) this.startVolumePulse();
    else this.stopVolumePulse();
  }

  private volumePulseRaf: number | null = null;
  private smoothedVolume = 0;

  private startVolumePulse() {
    this.stopVolumePulse();
    const callBtn = this.panel?.querySelector(".solai-call-btn") as HTMLElement | null;
    if (!callBtn) return;
    let t = 0;
    const loop = () => {
      if (!this.callActive || !this.conversation) return;
      try {
        const conv = this.conversation as { getInputVolume?: () => number; getOutputVolume?: () => number };
        const inV = typeof conv.getInputVolume === "function" ? conv.getInputVolume() : 0;
        const outV = typeof conv.getOutputVolume === "function" ? conv.getOutputVolume() : 0;
        const vol = Math.max(inV, outV);
        this.smoothedVolume = this.smoothedVolume * 0.7 + vol * 0.3;
        const scale = 1 + Math.min(this.smoothedVolume * 1.5, 0.08);
        callBtn.style.transform = `scale(${scale})`;
      } catch {
        t += 0.02;
        const breath = 1 + 0.02 * Math.sin(t);
        callBtn.style.transform = `scale(${breath})`;
      }
      this.volumePulseRaf = requestAnimationFrame(loop);
    };
    this.volumePulseRaf = requestAnimationFrame(loop);
  }

  private stopVolumePulse() {
    if (this.volumePulseRaf != null) {
      cancelAnimationFrame(this.volumePulseRaf);
      this.volumePulseRaf = null;
    }
    const callBtn = this.panel?.querySelector(".solai-call-btn") as HTMLElement | null;
    if (callBtn) callBtn.style.transform = "";
  }

  private disconnect() {
    this.clearResponseTimeout();
    this.endCurrentSession();
    this.setState("idle");
  }

  private async sendText() {
    const input = this.inputEl;
    if (!input?.value.trim()) return;

    const text = input.value.trim();
    input.value = "";
    this.addMessage("user", text);
    this.setState("processing");

    const ok = await this.ensureChatSession();
    if (!ok || !this.conversation) {
      this.setState("error");
      return;
    }

    this.startResponseTimeout();
    this.conversation.sendUserMessage(text);
    if (DEV) console.log("[SolAI] user text sent");
  }

  private async toggleCall() {
    if (this.callActive) {
      if (DEV) console.log("[SolAI] toggleCall: colgar llamada");
      this.endCurrentSession();
      this.setState("idle");
      await this.ensureChatSession();
    } else {
      if (DEV) console.log("[SolAI] toggleCall: iniciar llamada");
      await this.connectCall();
    }
  }

  private addMessage(role: "user" | "agent", text: string) {
    this.messages.push({ role, text });
    this.updateEmptyState();
    const bubble = document.createElement("div");
    bubble.className = `solai-bubble solai-bubble-${role}`;
    bubble.textContent = text;
    this.chatContainer?.appendChild(bubble);
    this.chatContainer?.scrollTo({ top: this.chatContainer.scrollHeight, behavior: "smooth" });
  }

  private updateEmptyState() {
    const empty = this.panel?.querySelector(".solai-chat-empty");
    if (empty) (empty as HTMLElement).hidden = this.messages.length > 0;
  }
}
