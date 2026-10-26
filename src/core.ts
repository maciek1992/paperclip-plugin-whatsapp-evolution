// Czysta logika (bez zależności od hosta) — testowana jednostkowo.

export interface PluginSettings {
  evolutionUrl: string;
  evolutionApiKey: unknown;
  instanceName: string;
  groupName: string;
  groupJid: string;
  allowedNumbers: string[];
  replyAsUserId: string;
  defaultAgentName: string;
  replyWindowHours: number;
  ackReaction: string;
}

export function readSettings(raw: Record<string, unknown> | null | undefined): PluginSettings {
  const c = raw ?? {};
  const str = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
  const allowed = Array.isArray(c.allowedNumbers)
    ? c.allowedNumbers
    : typeof c.allowedNumbers === "string"
      ? c.allowedNumbers.split(/[,\s]+/)
      : [];
  return {
    evolutionUrl: str(c.evolutionUrl, "http://localhost:8080").replace(/\/+$/, ""),
    evolutionApiKey: c.evolutionApiKey,
    instanceName: str(c.instanceName),
    groupName: str(c.groupName, "Agent"),
    groupJid: str(c.groupJid),
    allowedNumbers: allowed.map((n) => normalizePhone(String(n))).filter(Boolean),
    replyAsUserId: str(c.replyAsUserId),
    defaultAgentName: typeof c.defaultAgentName === "string" ? c.defaultAgentName.trim() : "CEO",
    replyWindowHours: typeof c.replyWindowHours === "number" && c.replyWindowHours > 0 ? c.replyWindowHours : 12,
    ackReaction: typeof c.ackReaction === "string" ? c.ackReaction : "👀",
  };
}

/**
 * Warianty reakcji do wysłania. Evolution przyjmuje dokładnie jedno emoji (emoji-regex);
 * wybieraki emoji doklejają selektor wariantu U+FE0F albo spacje — wtedy próbujemy bez nich.
 */
export function reactionCandidates(value: string): string[] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  const stripped = trimmed.replace(/[︎️‍\s]/g, "");
  return [...new Set([trimmed, stripped].filter(Boolean))];
}

/** Czy wartość potwierdzenia to tekst (litery/cyfry), a nie emoji — wtedy wysyłamy odpowiedź z cytatem. */
export function isTextAck(value: string): boolean {
  return /[\p{L}\p{N}]/u.test((value ?? "").trim());
}

export function normalizePhone(value: string): string {
  return value.replace(/@.*$/, "").replace(/[^0-9]/g, "");
}

/** Znormalizowana wiadomość przychodząca z webhooka Evolution (messages.upsert). */
export interface IncomingMessage {
  instance: string;
  remoteJid: string;
  messageId: string;
  fromMe: boolean;
  senderPhone: string; // z participantAlt (gdy WhatsApp ukrywa numer za LID) albo participant
  senderLid: string;
  pushName: string;
  text: string;
  quotedMessageId: string | null;
  quotedText: string | null;
  timestamp: number;
  /** Klucz API instancji, który Evolution dołącza do każdego webhooka (do uwierzytelnienia). */
  apikey: string;
}

/** Porównanie w stałym czasie (bez przecieku długości wspólnego prefiksu). */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function parseEvolutionWebhook(body: unknown): IncomingMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const event = String(b.event ?? "").toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return null;
  const data = b.data;
  if (!data || typeof data !== "object") return null;
  const key = data.key ?? {};
  const msg = data.message ?? {};
  const ext = msg.extendedTextMessage ?? {};
  const ctxInfo = data.contextInfo ?? ext.contextInfo ?? msg.imageMessage?.contextInfo ?? null;
  const text: string =
    msg.conversation ??
    ext.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    "";
  const quoted = ctxInfo?.quotedMessage ?? null;
  const quotedText: string | null = quoted
    ? (quoted.conversation ?? quoted.extendedTextMessage?.text ?? quoted.imageMessage?.caption ?? null)
    : null;
  const participant: string = key.participant ?? "";
  const participantAlt: string = key.participantAlt ?? "";
  const senderPhone = normalizePhone(
    participantAlt.endsWith("@s.whatsapp.net") ? participantAlt
      : participant.endsWith("@s.whatsapp.net") ? participant
        : participantAlt || "",
  );
  return {
    instance: String(b.instance ?? ""),
    remoteJid: String(key.remoteJid ?? ""),
    messageId: String(key.id ?? ""),
    fromMe: key.fromMe === true,
    senderPhone,
    senderLid: participant.endsWith("@lid") ? participant : "",
    pushName: String(data.pushName ?? ""),
    text: String(text ?? "").trim(),
    quotedMessageId: ctxInfo?.stanzaId ? String(ctxInfo.stanzaId) : null,
    quotedText,
    timestamp: Number(data.messageTimestamp ?? 0),
    apikey: typeof b.apikey === "string" ? b.apikey : "",
  };
}

/** Identyfikator zadania w treści, np. "[ACME-12]". */
export function extractIssueRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\[([A-Z][A-Z0-9]{1,9}-\d+)\]/);
  return m ? m[1] : null;
}

export function formatOutgoing(issueIdentifier: string | null, message: string): string {
  const body = message.trim();
  return issueIdentifier ? `[${issueIdentifier}] ${body}` : body;
}

export function formatReplyComment(pushName: string, phone: string, text: string): string {
  const who = pushName ? `${pushName} (+${phone})` : `+${phone}`;
  return `💬 WhatsApp — ${who}:\n\n${text}`;
}

export function newIssueTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `WhatsApp: ${oneLine.length > 70 ? oneLine.slice(0, 67) + "…" : oneLine}`;
}

export const TERMINAL_STATUSES = new Set(["done", "cancelled", "canceled", "closed"]);
