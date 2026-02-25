/**
 * SolAI Widget - Widget principal con Shadow DOM
 * Integración ElevenLabs ElevenAgents (voz + chat) vía Signed URLs
 * Separación clara: TEXT_CHAT (sin mic) vs VOICE_CALL (solo al pulsar mic)
 */
import { Conversation } from "@elevenlabs/client";
import { getStyles } from "./styles";

const DEV =
  typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");

const ICON_PHONE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

export type WidgetConfig = {
  tenant: string;
  apiBase: string;
  position: "br" | "bl" | "tr" | "tl";
  mode: "chat" | "voice" | "voice+chat";
  primaryColor: string;
  sessionTtlMinutes?: number;
};

export type DynamicVars = {
  tz: string;
  now_iso: string;
  today_human: string;
};

export type SessionData = {
  tenant: string;
  agentId: string;
  signedUrl: string;
  branding: { name?: string; primaryColor?: string; logoUrl?: string };
  dynamic_variables?: DynamicVars; // <-- NUEVO
};

export type Message = { role: "user" | "agent"; text: string };
export type WidgetState =
  | "idle"
  | "connecting"
  | "typing"
  | "in_call"
  | "processing"
  | "speaking"
  | "error";

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
  private titleEl: HTMLElement | null = null;
  private brandWrap: HTMLElement | null = null;
  private branding: SessionData["branding"] | null = null;

  // NUEVO: guardamos dynamic vars por sesión
  private dynamicVars: DynamicVars | null = null;

  private conversation: Awaited<ReturnType<typeof Conversation.startSession>> | null = null;
  private state: WidgetState = "idle";
  private messages: Message[] = [];
  private callActive = false;
  private micPermissionDenied = false;
  private agentStreamingText = "";
  private responseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly RESPONSE_TIMEOUT_MS = 12_000;
  private lastActivityAt = 0;
  private inactivityCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private inactivityTtlMs: number;
  private sessionExpired = false;
  private debug = false;
  private quotaBlockedUntil = 0;
  private readonly QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
  private sessionStartedAt = 0;
  private firstUserMessageSentAt: number | null = null;
  private suppressedGreetingOnce = false;
  private sessionCreateTimestamps: number[] = [];
  private totalSessionsCreated = 0;

  constructor(config: WidgetConfig) {
    this.config = {
      ...config,
      position: (["br", "bl", "tr", "tl"].includes(config.position)
        ? config.position
        : "br") as WidgetConfig["position"],
      mode: (["chat", "voice", "voice+chat"].includes(config.mode)
        ? config.mode
        : "voice+chat") as WidgetConfig["mode"],
    };
    this.inactivityTtlMs = (config.sessionTtlMinutes ?? 15) * 60 * 1000;

    try {
      if (
        typeof window !== "undefined" &&
        window.localStorage?.getItem("SOLAI_DEBUG") === "1"
      ) {
        this.debug = true;
      } else {
        this.debug = DEV;
      }
    } catch {
      this.debug = DEV;
    }

    // Restaurar cooldown de cuota si existe en localStorage
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const stored = window.localStorage.getItem("SOLAI_QUOTA_BLOCKED_UNTIL");
        if (stored) {
          const ts = parseInt(stored, 10);
          if (!Number.isNaN(ts)) {
            this.quotaBlockedUntil = ts;
          }
        }
      }
    } catch {
      // ignorar errores de acceso a localStorage
    }
  }

  private log(...args: unknown[]) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.log("[SolAI]", ...args);
  }

  private logVoice(...args: unknown[]) {
    if (!this.debug) return;
    // eslint-disable-next-line no-console
    console.log("[SolAI][voice]", ...args);
  }

  private canCreateSession(): boolean {
    const now = Date.now();
    this.sessionCreateTimestamps = this.sessionCreateTimestamps.filter(
      (t) => now - t < 60_000
    );

    if (this.sessionCreateTimestamps.length >= 5) {
      this.log("Local rate limit triggered");
      this.addMessage(
        "agent",
        "El asistente está recibiendo demasiadas solicitudes. Prueba en unos segundos."
      );
      return false;
    }

    this.sessionCreateTimestamps.push(now);
    return true;
  }

  private isQuotaError(input: unknown): boolean {
    const text =
      typeof input === "string"
        ? input
        : typeof input === "object" && input !== null
          ? JSON.stringify(input)
          : String(input ?? "");
    const lower = text.toLowerCase();
    return (
      lower.includes("quota") ||
      lower.includes("0 credits") ||
      lower.includes("no credits") ||
      lower.includes("missing_credits") ||
      lower.includes("credits remaining") ||
      lower.includes("exceeds your quota") ||
      lower.includes("insufficient_funds")
    );
  }

  private setQuotaBlocked(reason: string) {
    const now = Date.now();
    this.quotaBlockedUntil = now + this.QUOTA_COOLDOWN_MS;
    this.log("quota blocked", {
      reason,
      until: new Date(this.quotaBlockedUntil).toISOString(),
    });
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(
          "SOLAI_QUOTA_BLOCKED_UNTIL",
          String(this.quotaBlockedUntil)
        );
      }
    } catch {
      // ignorar errores de localStorage
    }
    const friendly =
      "Ahora mismo el asistente está temporalmente indisponible. Prueba en unos minutos.";
    this.addMessage("agent", friendly);
    this.endCurrentSession("quota");
    this.setState("idle");
  }

  private isQuotaBlocked(): boolean {
    const now = Date.now();
    if (this.quotaBlockedUntil && now >= this.quotaBlockedUntil) {
      this.quotaBlockedUntil = 0;
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.removeItem("SOLAI_QUOTA_BLOCKED_UNTIL");
        }
      } catch {
        // ignorar
      }
      return false;
    }
    return this.quotaBlockedUntil !== 0 && now < this.quotaBlockedUntil;
  }

  private shouldSuppressGreeting(text: string): boolean {
    if (this.firstUserMessageSentAt == null) return false;
    if (this.suppressedGreetingOnce) return false;
    if (!this.sessionStartedAt) return false;

    const now = Date.now();
    if (now - this.sessionStartedAt > 1500) return false;

    // No debe haber mensajes previos del agente
    const agentCount = this.messages.filter((m) => m.role === "agent").length;
    if (agentCount > 0) return false;

    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length > 120) return false;

    const re =
      /^(¡?hola|buenas|muy buenas|buenos días|buenas tardes|hey)[!.,\s]/i;
    if (!re.test(trimmed)) return false;

    this.log("suppressing greeting", trimmed);
    this.suppressedGreetingOnce = true;
    return true;
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
      <span class="solai-icon solai-icon-chat">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </span>
      <span class="solai-icon solai-icon-chevron">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </span>
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
        <div class="solai-panel-brand">
          <span class="solai-panel-title">Chat</span>
        </div>
        <button class="solai-btn-close" aria-label="Cerrar">×</button>
      </header>
      <div class="solai-chat-view">
        <div class="solai-chat-wrap">
          <div class="solai-chat" role="log"></div>
          <div class="solai-chat-empty">Escribe un mensaje…</div>
        </div>
        <div class="solai-input-row ${!showInput ? "solai-input-row-voice" : ""}">
          ${
            showInput
              ? '<input type="text" class="solai-input" placeholder="Escribe un mensaje…" autocomplete="off" />'
              : ""
          }
          ${showInput ? '<button class="solai-btn-send" aria-label="Enviar">↑</button>' : ""}
          ${showCall ? '<button class="solai-btn-call" aria-label="Iniciar llamada">' + ICON_PHONE + "</button>" : ""}
        </div>
      </div>
      ${
        showCall
          ? `
      <div class="solai-call-view">
        <div class="solai-call-status">En llamada…</div>
        <div class="solai-call-btn-wrap">
          <button class="solai-call-btn" aria-label="Colgar llamada">${ICON_PHONE}</button>
        </div>
      </div>
      `
          : ""
      }
    `;
    wrap.appendChild(this.panel);

    this.chatContainer = this.panel.querySelector(".solai-chat");
    this.titleEl = this.panel.querySelector(".solai-panel-title");
    this.brandWrap = this.panel.querySelector(".solai-panel-brand");
    this.inputEl = this.panel.querySelector(".solai-input");
    this.sendBtn = this.panel.querySelector(".solai-btn-send");
    this.callBtn = this.panel.querySelector(".solai-btn-call");
    this.closeBtn = this.panel.querySelector(".solai-btn-close");
    this.stateEl = this.panel.querySelector(".solai-state");

    const callScreenBtn = this.panel.querySelector(".solai-call-btn");
    if (callScreenBtn) callScreenBtn.addEventListener("click", () => this.toggleCall());

    this.closeBtn?.addEventListener("click", () => this.hardClose());
    this.sendBtn?.addEventListener("click", () => this.sendText());
    this.inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.sendText();
    });

    if (this.callBtn && this.config.mode !== "chat") {
      this.callBtn.addEventListener("click", () => this.toggleCall());
    }

    this.setUIForMode();
    this.startInactivityCheck();
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
      this.collapsePanel();
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
  }

  private collapsePanel() {
    this.panel?.classList.remove("solai-panel-open");
    this.panel?.classList.add("solai-panel-closing");
    this.button?.classList.remove("open");
    this.button?.setAttribute("aria-label", "Abrir chat");
    setTimeout(() => {
      this.panel!.hidden = true;
      this.panel?.classList.remove("solai-panel-closing");
    }, 220);
  }

  private hardClose() {
    this.panel?.classList.remove("solai-panel-open");
    this.panel?.classList.add("solai-panel-closing");
    this.button?.classList.remove("open");
    this.button?.setAttribute("aria-label", "Abrir chat");
    setTimeout(() => {
      this.panel!.hidden = true;
      this.panel?.classList.remove("solai-panel-closing");
      this.endCurrentSession("hard_close");
      this.clearChatMessages();
      this.sessionExpired = false;
      this.lastActivityAt = 0;
      this.setState("idle");
    }, 220);
  }

  private clearChatMessages() {
    this.messages = [];
    if (this.chatContainer) {
      this.chatContainer.innerHTML = "";
    }
    this.firstUserMessageSentAt = null;
    this.suppressedGreetingOnce = false;
    this.sessionStartedAt = 0;
    this.updateEmptyState();
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
        this.stateEl.innerHTML =
          '<span class="solai-typing-dots"><span></span><span></span><span></span></span>';
      } else {
        this.stateEl.innerHTML = labels[s]
          ? `<span class="solai-state-text">${labels[s]}</span>`
          : "";
      }
    }
    this.root
      ?.querySelector(".solai-widget-wrap")
      ?.classList.remove(
        "state-idle",
        "state-typing",
        "state-listening",
        "state-in-call",
        "state-thinking",
        "state-processing",
        "state-speaking",
        "state-error"
      );
    if (s !== "idle")
      this.root?.querySelector(".solai-widget-wrap")?.classList.add(`state-${s.replace("_", "-")}`);
    this.log("state:", s, "callActive:", this.callActive);
  }

  private async fetchSession(): Promise<SessionData> {
    if (this.isQuotaBlocked()) {
      this.log("fetchSession: blocked by quota cooldown");
      this.addMessage(
        "agent",
        "Ahora mismo el asistente está temporalmente indisponible. Prueba en unos minutos."
      );
      throw new Error("quota_blocked");
    }

    if (!this.canCreateSession()) {
      throw new Error("local_rate_limit");
    }

    // Pequeño delay humano para mitigar bots/loops
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));

    const tenant = String(this.config.tenant ?? "").trim();

    // Normaliza apiBase
    const baseRaw = String(this.config.apiBase ?? "").trim();
    const baseNoSlash = baseRaw.replace(/\/+$/, "");
    const base =
      baseNoSlash.startsWith("http://") || baseNoSlash.startsWith("https://")
        ? baseNoSlash
        : `https://${baseNoSlash.replace(/^\/\//, "")}`;

    const apiPrefix = base.endsWith("/api") ? base : `${base}/api`;
    const rootPrefix = base;

    const primaryUrl = `${apiPrefix}/widget/session?tenant=${encodeURIComponent(tenant)}`;
    const primaryUrlAlt = `${rootPrefix}/widget/session?tenant=${encodeURIComponent(tenant)}`;
    const fallbackUrl = `${apiPrefix}/widget/tenant?tenant=${encodeURIComponent(tenant)}`;
    const fallbackUrlAlt = `${rootPrefix}/widget/tenant?tenant=${encodeURIComponent(tenant)}`;

    this.log("fetchSession: requesting signedUrl", { primaryUrl, fallbackUrl, tenant });

    const tryFetch = async (u: string) =>
      fetch(u, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-tenant": tenant,
          "x-solai-tenant": tenant,
        },
      });

    const candidates = [primaryUrl, primaryUrlAlt, fallbackUrl, fallbackUrlAlt];
    let res: Response | null = null;
    let usedUrl: string | null = null;

    for (const u of candidates) {
      this.log("fetchSession: trying", u);
      const r = await tryFetch(u);
      if (r.status !== 404) {
        res = r;
        usedUrl = u;
        break;
      }
      res = r;
      usedUrl = u;
    }

    if (!res) {
      throw new Error("Session error: no response");
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        bodyText = "";
      }

      if (res.status === 404) {
        const endpointHint =
          "No existe el endpoint esperado para crear sesión. " +
          `He intentado: ${usedUrl ?? "(desconocido)"}. ` +
          "Revisa el Worker (routes) y que `apiBase` apunte al dominio correcto.";
        const extra = bodyText ? ` Detalle: ${bodyText}` : "";
        throw new Error(`${endpointHint}${extra}`);
      }

      if (res.status === 402 || res.status === 429 || this.isQuotaError(bodyText)) {
        this.setQuotaBlocked(`fetchSession_http_${res.status}`);
        throw new Error("quota");
      }

      let errMsg: string | undefined;
      try {
        const parsed = JSON.parse(bodyText || "{}") as { error?: string; message?: string };
        errMsg = parsed.error ?? parsed.message;
      } catch {
        // ignore
      }

      if (!errMsg && bodyText) errMsg = bodyText;

      if (res.status === 400 && (errMsg?.toLowerCase().includes("tenant") ?? false)) {
        throw new Error(errMsg);
      }

      throw new Error(errMsg ?? `Session error: ${res.status}`);
    }

    const data = (await res.json()) as Partial<SessionData>;

    if (!data || typeof data.signedUrl !== "string" || !data.signedUrl) {
      throw new Error(
        "Respuesta del servidor sin signedUrl. " +
          "Asegúrate de que el Worker expone /api/widget/session y devuelve { signedUrl }. " +
          "Ahora mismo parece que estás devolviendo solo config/tenant."
      );
    }

    const sessionData = data as SessionData;

    // Guardamos branding + dynamic vars en memoria
    this.branding = sessionData.branding ?? null;
    this.dynamicVars = sessionData.dynamic_variables ?? null;

    this.totalSessionsCreated += 1;
    this.log("fetchSession: ok", {
      tenant: sessionData.tenant,
      hasBranding: !!sessionData.branding,
      hasDynamicVars: !!sessionData.dynamic_variables,
      totalSessionsCreated: this.totalSessionsCreated,
    });

    return sessionData;
  }

  /**
   * Asegura sesión de chat activa. NO pide permisos de micrófono.
   */
  private async ensureChatSession(): Promise<boolean> {
    if (this.isQuotaBlocked()) {
      this.log("ensureChatSession: blocked by quota cooldown");
      this.addMessage(
        "agent",
        "Ahora mismo el asistente está temporalmente indisponible. Prueba en unos minutos."
      );
      return false;
    }
    if (this.callActive) {
      this.log("ensureChatSession: callActive=true, no se crea sesión de texto");
      return false;
    }
    if (this.conversation) {
      this.log("ensureChatSession: reusing existing session");
      return true;
    }

    this.setState("connecting");
    this.log("ensureChatSession: fetching session");

    try {
      const session = await this.fetchSession();
      this.log("session fetched ok");

      this.updateHeaderBranding();

      // OJO: pasamos dynamic vars con ambos nombres por compatibilidad SDK
      const convoOpts: any = {
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        textOnly: true,

        // compat
        dynamic_variables: this.dynamicVars ?? undefined,
        dynamicVariables: this.dynamicVars ?? undefined,

        onMessage: (msg: { source?: string; type?: string; message?: string }) => {
          if (msg.source === "user" && msg.type === "conversation_initiation_metadata") return;
          const text = (msg as { message?: string }).message;
          this.log("chat onMessage", msg.source, msg.type, text);
          if (text) {
            if (msg.source === "agent") {
              this.clearResponseTimeout();
              if (!this.shouldSuppressGreeting(text)) {
                this.addMessage("agent", text);
                if (DEV) console.log("[SolAI] agent text appended");
              }
              this.setState("idle");
            }
            if (msg.source === "user") this.addMessage("user", text);
          }
        },

        onAgentChatResponsePart: (part: { type?: string; text?: string }) => {
          this.log("chat onAgentChatResponsePart", part.type, part.text ?? "");
          if (part.type === "start") this.agentStreamingText = "";
          if (part.text) this.agentStreamingText += part.text;
          if (part.type === "stop") {
            this.clearResponseTimeout();
            if (this.agentStreamingText.trim()) {
              const full = this.agentStreamingText.trim();
              if (!this.shouldSuppressGreeting(full)) {
                this.addMessage("agent", full);
                if (DEV) console.log("[SolAI] agent text appended (stream complete)");
              }
            }
            this.agentStreamingText = "";
            this.setState("idle");
          }
        },

        onStatusChange: (s: { status?: string }) => {
          if (s.status === "connected") {
            this.log("chat ws connected");
            this.setState("idle");
          }
          if (s.status === "connecting") this.setState("connecting");
          if (s.status === "disconnected") this.setState("idle");
        },

        onError: (err: unknown) => {
          console.error("[SolAI] ElevenLabs chat error:", err);
          const str = String(err);
          if (this.isQuotaError(str)) {
            this.setQuotaBlocked("chat_onError");
            return;
          }
          if (str.includes("token") || str.includes("expir")) {
            this.disconnect();
            this.ensureChatSession();
          } else {
            this.clearResponseTimeout();
            this.setState("error");
          }
        },

        onDebug: (payload: unknown) => {
          this.log("chat onDebug", payload);
        },
      };

      const conversation = await Conversation.startSession(convoOpts);

      this.conversation = conversation;
      this.callActive = false;
      this.updateLastActivity();
      this.sessionStartedAt = Date.now();
      this.suppressedGreetingOnce = false;
      this.setState("idle");
      this.updateCallButton();
      this.log("connectChat: sesión texto activa");
      return true;
    } catch (e) {
      console.error("[SolAI] Connect chat error:", e);
      if (!this.isQuotaBlocked()) {
        this.addMessage("agent", `Error: ${(e as Error).message}`);
        this.setState("error");
      } else {
        this.setState("idle");
      }
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
   */
  private async connectCall() {
    if (this.callActive && this.conversation) return;

    if (this.isQuotaBlocked()) {
      this.logVoice("connectCall: blocked by quota cooldown");
      this.addMessage(
        "agent",
        "Ahora mismo el asistente está temporalmente indisponible. Prueba en unos minutos."
      );
      return;
    }

    this.logVoice("connectCall: solicitando micrófono");

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      };
      this.logVoice("getUserMedia constraints", constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      if (track) {
        this.logVoice("mic ok settings", track.getSettings());
      } else {
        this.logVoice("mic ok but no audio track");
      }
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      this.micPermissionDenied = true;
      this.addMessage("agent", "No se pudo acceder al micrófono. Usa el chat por texto.");
      this.logVoice("connectCall: permiso mic denegado", err);
      return;
    }

    this.endCurrentSession("switch_to_call");
    this.updateLastActivity();

    this.setState("connecting");
    this.logVoice("connectCall: iniciando sesión voz");

    try {
      const session = await this.fetchSession();
      this.updateHeaderBranding();

      const convoOpts: any = {
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        textOnly: false,

        // compat
        dynamic_variables: this.dynamicVars ?? undefined,
        dynamicVariables: this.dynamicVars ?? undefined,

        onMessage: (msg: { source?: string; type?: string; message?: string }) => {
          if (msg.source === "user" && msg.type === "conversation_initiation_metadata") return;
          const text = (msg as { message?: string }).message;
          this.logVoice("onMessage", msg.source, msg.type, text);
          if (text) {
            if (msg.source === "agent") this.addMessage("agent", text);
            if (msg.source === "user") this.addMessage("user", text);
          }
        },

        onModeChange: (m: { mode?: string }) => {
          this.logVoice("onModeChange", m.mode);
          if (m.mode === "listening") this.setState("in_call");
          else if (m.mode === "speaking") this.setState("speaking");
        },

        onStatusChange: (s: { status?: string }) => {
          this.logVoice("onStatusChange", s.status);
          if (s.status === "connected") this.setState("in_call");
          if (s.status === "connecting") this.setState("connecting");
          if (s.status === "disconnected") {
            this.callActive = false;
            this.updateCallButton();
            this.setState("idle");
          }
        },

        onError: (err: unknown) => {
          console.error("[SolAI] ElevenLabs voice error:", err);
          const str = String(err);
          if (this.isQuotaError(str)) {
            this.setQuotaBlocked("voice_onError");
            return;
          }
          if (str.includes("token") || str.includes("expir")) {
            this.endCurrentSession("voice_token");
            this.connectCall();
          } else {
            this.setState("error");
          }
        },

        onDebug: (payload: unknown) => {
          this.logVoice("onDebug", payload);
        },

        onVadScore: (score: unknown) => {
          this.logVoice("onVadScore", score);
        },

        onAudio: (event: unknown) => {
          this.logVoice("onAudio event", event);
        },
      };

      const conversation = await Conversation.startSession(convoOpts);

      this.conversation = conversation;
      this.callActive = true;
      this.updateLastActivity();
      this.sessionStartedAt = Date.now();
      this.suppressedGreetingOnce = false;
      this.setState("in_call");
      this.updateCallButton();
      this.logVoice("connectCall: sesión voz activa");
    } catch (e) {
      console.error("[SolAI] Connect voice error:", e);
      if (!this.isQuotaBlocked()) {
        this.addMessage("agent", `Error: ${(e as Error).message}`);
        this.setState("error");
      } else {
        this.setState("idle");
      }
    }
  }

  private endCurrentSession(reason: string = "manual") {
    this.clearResponseTimeout();
    this.stopVolumePulse();
    if (this.conversation) {
      this.conversation.endSession().catch(() => {});
      this.conversation = null;
    }
    this.callActive = false;
    this.updateCallButton();
    this.log("endCurrentSession: sesión cerrada. reason=", reason);
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
        const conv = this.conversation as {
          getInputVolume?: () => number;
          getOutputVolume?: () => number;
        };
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
    this.endCurrentSession("disconnect");
    this.setState("idle");
  }

  private async sendText() {
    const input = this.inputEl;
    if (!input?.value.trim()) return;

    const text = input.value.trim();
    input.value = "";
    this.updateLastActivity();

    if (this.callActive) {
      this.addMessage("agent", "Termina la llamada para usar el chat por texto.");
      return;
    }

    if (this.firstUserMessageSentAt == null) {
      this.firstUserMessageSentAt = Date.now();
    }

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
      this.logVoice("toggleCall: colgar llamada");
      this.endCurrentSession("toggle_call_hangup");
      this.setState("idle");
    } else {
      this.logVoice("toggleCall: iniciar llamada");
      await this.connectCall();
    }
  }

  private addMessage(role: "user" | "agent", text: string) {
    if (role === "agent" && this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      if (last.role === "agent" && last.text.trim() === text.trim()) return;
    }
    this.messages.push({ role, text });
    this.updateEmptyState();
    const bubble = document.createElement("div");
    bubble.className = `solai-bubble solai-bubble-${role}`;
    bubble.textContent = text;
    this.chatContainer?.appendChild(bubble);
    this.chatContainer?.scrollTo({
      top: this.chatContainer.scrollHeight,
      behavior: "smooth",
    });
  }

  private updateHeaderBranding() {
    const title = this.branding?.name ?? "Chat";
    if (this.titleEl) this.titleEl.textContent = title;

    const logo = this.brandWrap?.querySelector(".solai-panel-logo");
    if (this.branding?.logoUrl) {
      if (logo instanceof HTMLImageElement) {
        logo.src = this.branding.logoUrl;
        logo.hidden = false;
      } else if (this.brandWrap && this.titleEl) {
        const img = document.createElement("img");
        img.className = "solai-panel-logo";
        img.alt = "";
        img.src = this.branding.logoUrl;
        this.brandWrap.insertBefore(img, this.titleEl);
      }
    } else if (logo) {
      (logo as HTMLElement).hidden = true;
    }
  }

  private updateEmptyState() {
    const empty = this.panel?.querySelector(".solai-chat-empty") as HTMLElement | null;
    if (empty) {
      empty.hidden = this.messages.length > 0;
      empty.textContent = this.sessionExpired
        ? "Sesión caducada, escribe para empezar"
        : "Escribe un mensaje…";
    }
  }

  private updateLastActivity() {
    this.lastActivityAt = Date.now();
    this.sessionExpired = false;
  }

  private startInactivityCheck() {
    this.stopInactivityCheck();
    const intervalMs = 60_000;
    this.inactivityCheckIntervalId = setInterval(() => {
      if (!this.conversation || this.callActive) return;
      if (this.lastActivityAt === 0) return;
      if (Date.now() - this.lastActivityAt >= this.inactivityTtlMs) {
        this.expireSession();
      }
    }, intervalMs);
  }

  private stopInactivityCheck() {
    if (this.inactivityCheckIntervalId) {
      clearInterval(this.inactivityCheckIntervalId);
      this.inactivityCheckIntervalId = null;
    }
  }

  private expireSession() {
    if (!this.conversation && !this.sessionExpired) return;
    if (DEV) console.log("[SolAI] expireSession: TTL inactividad alcanzado");
    this.endCurrentSession("inactivity_ttl");
    this.clearChatMessages();
    this.sessionExpired = true;
    this.lastActivityAt = 0;
    this.updateEmptyState();
  }
}