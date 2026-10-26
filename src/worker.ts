import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import {
  readSettings,
  parseEvolutionWebhook,
  extractIssueRef,
  formatOutgoing,
  formatReplyComment,
  newIssueTitle,
  TERMINAL_STATUSES,
  safeEqual,
  reactionCandidates,
  isTextAck,
  type PluginSettings,
  type IncomingMessage,
} from "./core.js";

const ORIGIN_KIND = "plugin:local.whatsapp-evolution:message";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ThreadLink {
  issueId: string;
  identifier: string | null;
  kind: "ask" | "notify";
  sentAt: string;
}

let ctxRef: PluginContext | null = null;

// ---------- Evolution API ----------

async function apiKey(ctx: PluginContext, s: PluginSettings, companyId: string): Promise<string> {
  const ref = s.evolutionApiKey;
  if (!ref) throw new Error("Brak klucza API Evolution w ustawieniach pluginu");
  const binding =
    typeof ref === "string" ? { type: "secret_ref" as const, secretId: ref, version: "latest" as const } : (ref as any);
  return ctx.secrets.resolve(binding, { companyId, configPath: "evolutionApiKey" });
}

async function evo(
  ctx: PluginContext,
  s: PluginSettings,
  companyId: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<any> {
  const key = await apiKey(ctx, s, companyId);
  // Klient hosta (ctx.http.fetch) blokuje adresy z sieci prywatnej (ochrona SSRF), a Evolution
  // działa w LAN. Połączenie bezpośrednie wyłącznie z adresem Evolution ustawionym przez
  // administratora; ścieżka budowana po stronie pluginu, więc nie da się nim sięgnąć gdzie indziej.
  const res = await globalThis.fetch(`${s.evolutionUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", apikey: key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = typeof json === "object" ? JSON.stringify(json).slice(0, 300) : String(json).slice(0, 300);
    throw new Error(`Evolution ${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return json;
}

async function groupJid(ctx: PluginContext, s: PluginSettings, companyId: string): Promise<string> {
  if (s.groupJid) return s.groupJid;
  const cacheKey = { scopeKind: "company" as const, scopeId: companyId, stateKey: `group-jid:${s.instanceName}:${s.groupName}` };
  const cached = await ctx.state.get(cacheKey);
  if (typeof cached === "string" && cached) return cached;
  const data = await evo(ctx, s, companyId, "GET", `/group/fetchAllGroups/${encodeURIComponent(s.instanceName)}?getParticipants=false`);
  const groups: any[] = Array.isArray(data) ? data : (data?.groups ?? []);
  const wanted = s.groupName.trim().toLowerCase();
  const hits = groups.filter((g) => String(g?.subject ?? "").trim().toLowerCase() === wanted);
  if (hits.length !== 1) {
    throw new Error(
      `Grupa "${s.groupName}" ${hits.length === 0 ? "nie istnieje lub numer instancji nie jest jej członkiem" : "jest niejednoznaczna"}`,
    );
  }
  const jid = String(hits[0].id);
  await ctx.state.set(cacheKey, jid);
  return jid;
}

async function sendText(ctx: PluginContext, s: PluginSettings, companyId: string, text: string): Promise<string> {
  const jid = await groupJid(ctx, s, companyId);
  const res = await evo(ctx, s, companyId, "POST", `/message/sendText/${encodeURIComponent(s.instanceName)}`, {
    number: jid,
    text,
  });
  return String(res?.key?.id ?? "");
}

/**
 * Uwierzytelnia webhook: Evolution dołącza klucz instancji do każdej wiadomości.
 * Gdy klucz w sekrecie to klucz globalny (inny niż instancji), potwierdzamy wiadomość
 * odpytując Evolution własnym kluczem — podrobiony webhook tego nie przejdzie.
 */
async function verifyWithEvolution(
  ctx: PluginContext,
  s: PluginSettings,
  companyId: string,
  m: IncomingMessage,
): Promise<boolean> {
  if (m.apikey && safeEqual(m.apikey, await apiKey(ctx, s, companyId))) return true;
  const res = await evo(ctx, s, companyId, "POST", `/chat/findMessages/${encodeURIComponent(s.instanceName)}`, {
    where: { key: { id: m.messageId } },
  });
  const records: any[] = Array.isArray(res) ? res : (res?.messages?.records ?? res?.records ?? []);
  return records.some((r) => r?.key?.id === m.messageId && r?.key?.remoteJid === m.remoteJid);
}

async function react(
  ctx: PluginContext,
  s: PluginSettings,
  companyId: string,
  m: IncomingMessage,
  link?: { issueId: string; identifier: string | null },
): Promise<void> {
  if (!s.ackReaction.trim()) return;
  if (isTextAck(s.ackReaction)) {
    // WhatsApp przyjmuje jako reakcję tylko emoji — tekstowe potwierdzenie wysyłamy jako odpowiedź z cytatem.
    try {
      const res = await evo(ctx, s, companyId, "POST", `/message/sendText/${encodeURIComponent(s.instanceName)}`, {
        number: m.remoteJid,
        text: s.ackReaction.trim(),
        quoted: {
          key: { id: m.messageId, remoteJid: m.remoteJid, fromMe: false, participant: m.senderLid || undefined },
          message: { conversation: m.text },
        },
      });
      const ackId = String(res?.key?.id ?? "");
      if (link && ackId) {
        await linkMessage(ctx, companyId, ackId, { ...link, kind: "notify", sentAt: new Date().toISOString() });
      }
    } catch (err) {
      ctx.logger.warn("Nie udało się wysłać potwierdzenia", { error: String(err) });
    }
    return;
  }
  let lastError: unknown = null;
  for (const reaction of reactionCandidates(s.ackReaction)) {
    try {
      await evo(ctx, s, companyId, "POST", `/message/sendReaction/${encodeURIComponent(s.instanceName)}`, {
        key: { remoteJid: m.remoteJid, fromMe: false, id: m.messageId, participant: m.senderLid || undefined },
        reaction,
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) ctx.logger.warn("Nie udało się dodać reakcji", { error: String(lastError) });
}

// ---------- Paperclip ----------

async function resolveIssue(ctx: PluginContext, companyId: string, ref: string) {
  const r = ref.trim();
  if (UUID_RE.test(r)) return ctx.issues.get(r, companyId);
  const wanted = r.toUpperCase();
  for (let offset = 0; offset < 5000; offset += 200) {
    const page = await ctx.issues.list({ companyId, limit: 200, offset });
    const hit = page.find((i: any) => String(i.identifier ?? "").toUpperCase() === wanted);
    if (hit) return hit;
    if (page.length < 200) break;
  }
  return null;
}

async function replyActorUserId(ctx: PluginContext, s: PluginSettings, companyId: string): Promise<string> {
  if (s.replyAsUserId) return s.replyAsUserId;
  const members = await ctx.access.members.list({ companyId });
  const humans = members.filter((m) => m.principalType === "user" && m.status === "active");
  const owner = humans.find((m) => m.membershipRole === "owner") ?? humans[0];
  if (!owner) throw new Error("Brak aktywnego członka firmy, w którego imieniu można wpisać odpowiedź");
  return owner.principalId;
}

async function defaultAgentId(ctx: PluginContext, s: PluginSettings, companyId: string): Promise<string | null> {
  if (!s.defaultAgentName) return null;
  const agents = await ctx.agents.list({ companyId });
  const wanted = s.defaultAgentName.toLowerCase();
  const hit = agents.find((a: any) => String(a.name ?? "").toLowerCase() === wanted || a.id === s.defaultAgentName);
  return hit ? hit.id : null;
}

function st(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey };
}

async function linkMessage(ctx: PluginContext, companyId: string, messageId: string, link: ThreadLink) {
  if (!messageId) return;
  await ctx.state.set(st(companyId, `msg:${messageId}`), link);
  if (link.kind === "ask") await ctx.state.set(st(companyId, "last-ask"), { ...link, messageId });
}

// ---------- Narzędzia agenta ----------

async function sendFromAgent(
  ctx: PluginContext,
  kind: "ask" | "notify",
  params: unknown,
  runCtx: { companyId: string; agentId: string },
) {
  const p = (params ?? {}) as { issueId?: string; message?: string };
  const message = String(p.message ?? "").trim();
  if (!message) return { error: "Pusta treść wiadomości" };
  const companyId = runCtx.companyId;
  const s = readSettings(await ctx.config.get(companyId));
  let issue: any = null;
  if (p.issueId) {
    issue = await resolveIssue(ctx, companyId, String(p.issueId));
    if (!issue) return { error: `Nie znaleziono zadania ${p.issueId}` };
  } else if (kind === "ask") {
    return { error: "Narzędzie ask wymaga issueId bieżącego zadania" };
  }
  const identifier = issue?.identifier ?? null;
  const messageId = await sendText(ctx, s, companyId, formatOutgoing(identifier, message));
  if (issue) {
    await linkMessage(ctx, companyId, messageId, {
      issueId: issue.id,
      identifier,
      kind,
      sentAt: new Date().toISOString(),
    });
  }
  ctx.logger.info("Wysłano wiadomość WhatsApp", { kind, issue: identifier, messageId, agentId: runCtx.agentId });
  return {
    content:
      kind === "ask"
        ? `Pytanie wysłane na WhatsApp (message_id ${messageId}). Zakończ teraz run — odpowiedź przyjdzie jako komentarz w ${identifier} i obudzi cię.`
        : `Wiadomość wysłana na WhatsApp (message_id ${messageId}).`,
    data: { messageId, issue: identifier },
  };
}

// ---------- Webhook ----------

async function companiesForInstance(ctx: PluginContext, instance: string) {
  const out: { companyId: string; s: PluginSettings }[] = [];
  const companies = await ctx.companies.list({ limit: 100 });
  for (const c of companies as any[]) {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = await ctx.config.get(c.id);
    } catch {
      continue;
    }
    if (!cfg || !cfg.evolutionApiKey) continue;
    const s = readSettings(cfg);
    if (s.instanceName === instance) out.push({ companyId: c.id, s });
  }
  return out;
}

async function routeToIssue(ctx: PluginContext, companyId: string, s: PluginSettings, m: IncomingMessage) {
  // 1) Cytat wiadomości agenta → dokładne powiązanie
  if (m.quotedMessageId) {
    const link = (await ctx.state.get(st(companyId, `msg:${m.quotedMessageId}`))) as ThreadLink | null;
    if (link?.issueId) return { issueId: link.issueId, how: "cytat" };
  }
  // 2) [ACME-12] w cytacie albo w treści
  const ref = extractIssueRef(m.quotedText) ?? extractIssueRef(m.text);
  if (ref) {
    const issue = await resolveIssue(ctx, companyId, ref);
    if (issue) return { issueId: issue.id, how: `oznaczenie ${ref}` };
  }
  // 3) Ostatnie pytanie agenta w oknie czasowym
  const last = (await ctx.state.get(st(companyId, "last-ask"))) as (ThreadLink & { messageId: string }) | null;
  if (last?.issueId) {
    const ageH = (Date.now() - Date.parse(last.sentAt)) / 3_600_000;
    if (ageH <= s.replyWindowHours) {
      const issue: any = await ctx.issues.get(last.issueId, companyId);
      if (issue && !TERMINAL_STATUSES.has(String(issue.status))) return { issueId: issue.id, how: "ostatnie pytanie" };
    }
  }
  return null;
}

async function handleIncoming(ctx: PluginContext, m: IncomingMessage) {
  if (m.fromMe || !m.text || !m.messageId) return;
  const targets = await companiesForInstance(ctx, m.instance);
  for (const { companyId, s } of targets) {
    const jid = await groupJid(ctx, s, companyId);
    if (m.remoteJid !== jid) continue;
    if (!s.allowedNumbers.includes(m.senderPhone)) {
      ctx.logger.info("Pominięto wiadomość od nieuprawnionego numeru", { sender: m.senderPhone ? `+${m.senderPhone}` : m.senderLid });
      continue;
    }
    const seenKey = st(companyId, `seen:${m.messageId}`);
    if (await ctx.state.get(seenKey)) continue;
    if (!(await verifyWithEvolution(ctx, s, companyId, m))) {
      ctx.logger.warn("Odrzucono webhook — Evolution nie potwierdza wiadomości", { messageId: m.messageId });
      continue;
    }
    await ctx.state.set(seenKey, new Date().toISOString());

    const actorUserId = await replyActorUserId(ctx, s, companyId);
    const route = await routeToIssue(ctx, companyId, s, m);
    if (route) {
      const issue: any = await ctx.issues.get(route.issueId, companyId);
      if (issue && TERMINAL_STATUSES.has(String(issue.status))) {
        await ctx.issues.update(issue.id, { status: "todo" }, companyId, { actorUserId });
      }
      await ctx.issues.createComment(route.issueId, formatReplyComment(m.pushName, m.senderPhone, m.text), companyId, {
        actorUserId,
      });
      ctx.logger.info("Odpowiedź z WhatsApp dopisana do zadania", { issue: issue?.identifier, how: route.how });
      await react(ctx, s, companyId, m, { issueId: route.issueId, identifier: issue?.identifier ?? null });
      continue;
    }

    const agentId = await defaultAgentId(ctx, s, companyId);
    if (!agentId) {
      ctx.logger.info("Wiadomość nie pasuje do żadnego wątku, a zakładanie nowych spraw jest wyłączone");
      continue;
    }
    // Trwała deduplikacja (przetrwa reinstalację pluginu): zadanie z tej wiadomości już istnieje?
    const existing = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: m.messageId, limit: 1 });
    if (existing.some((i: any) => i.originId === m.messageId)) {
      ctx.logger.info("Pominięto — zadanie z tej wiadomości już istnieje", { issue: (existing[0] as any).identifier });
      continue;
    }
    const created: any = await ctx.issues.create({
      companyId,
      title: newIssueTitle(m.text),
      description: `${formatReplyComment(m.pushName, m.senderPhone, m.text)}\n\n_Zadanie założone automatycznie z grupy WhatsApp. Odpowiadaj przez narzędzie WhatsApp \`ask\`/\`notify\`._`,
      status: "todo",
      assigneeAgentId: agentId,
      originKind: ORIGIN_KIND,
      originId: m.messageId,
      actor: { actorUserId },
    });
    await linkMessage(ctx, companyId, m.messageId, {
      issueId: created.id,
      identifier: created.identifier ?? null,
      kind: "notify",
      sentAt: new Date().toISOString(),
    });
    ctx.logger.info("Założono zadanie z wiadomości WhatsApp", { issue: created.identifier });
    await react(ctx, s, companyId, m, { issueId: created.id, identifier: created.identifier ?? null });
  }
}

// ---------- Skill dla agentów ----------

export const SKILL_KEY = "whatsapp-conversation";

/** Instaluje/aktualizuje skill pluginu w bibliotece każdej skonfigurowanej firmy. */
async function reconcileSkills(ctx: PluginContext): Promise<void> {
  const companies = (await ctx.companies.list({ limit: 100 })) as any[];
  for (const c of companies) {
    try {
      const cfg = await ctx.config.get(c.id);
      if (!cfg || !cfg.evolutionApiKey) continue;
      // Po zmianie wersji pluginu przywróć skill do aktualnej treści (reconcile nie nadpisuje istniejącego).
      const versionKey = st(c.id, "skill-version");
      const installed = await ctx.state.get(versionKey);
      const version = ctx.manifest.version;
      const res: any =
        installed && installed !== version
          ? await ctx.skills.managed.reset(SKILL_KEY, c.id)
          : await ctx.skills.managed.reconcile(SKILL_KEY, c.id);
      if (!installed && res?.status && res.status !== "created") {
        await ctx.skills.managed.reset(SKILL_KEY, c.id);
      }
      await ctx.state.set(versionKey, version);
      ctx.logger.info("Skill WhatsApp w bibliotece firmy", { companyId: c.id, status: res?.status ?? "ok", version });
    } catch (err) {
      ctx.logger.warn("Nie udało się zainstalować skilla WhatsApp", { companyId: c.id, error: String(err) });
    }
  }
}

// ---------- Plugin ----------

const plugin = definePlugin({
  async setup(ctx) {
    ctxRef = ctx;
    ctx.tools.register(
      "ask",
      {
        displayName: "Zapytaj człowieka na WhatsApp",
        description:
          "Zadaj człowiekowi pytanie w grupie WhatsApp. Po wysłaniu zakończ run — odpowiedź przyjdzie jako komentarz w zadaniu.",
        parametersSchema: {
          type: "object",
          properties: { issueId: { type: "string" }, message: { type: "string" } },
          required: ["issueId", "message"],
        },
      },
      (params, runCtx) => sendFromAgent(ctx, "ask", params, runCtx),
    );
    ctx.tools.register(
      "notify",
      {
        displayName: "Wyślij informację na WhatsApp",
        description: "Wyślij informację do grupy WhatsApp bez czekania na odpowiedź.",
        parametersSchema: {
          type: "object",
          properties: { issueId: { type: "string" }, message: { type: "string" } },
          required: ["message"],
        },
      },
      (params, runCtx) => sendFromAgent(ctx, "notify", params, runCtx),
    );
    // Po rejestracji handlerów: skill do biblioteki firm (host restartuje workera po zmianie ustawień,
    // więc to wykona się też po pierwszym zapisaniu konfiguracji).
    setTimeout(() => {
      reconcileSkills(ctx).catch((err) => ctx.logger.warn("reconcileSkills", { error: String(err) }));
    }, 500);
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = ctxRef;
    if (!ctx || input.endpointKey !== "evolution") return;
    const m = parseEvolutionWebhook(input.parsedBody ?? safeJson(input.rawBody));
    if (!m) return;
    try {
      await handleIncoming(ctx, m);
    } catch (err) {
      ctx.logger.error("Błąd obsługi wiadomości WhatsApp", { error: String(err), messageId: m.messageId });
      throw err;
    }
  },

  async onApiRequest(input) {
    const ctx = ctxRef;
    if (!ctx) return { status: 503, body: { error: "Plugin nie jest gotowy" } };
    if (input.routeKey !== "ask" && input.routeKey !== "notify") return { status: 404, body: { error: "Nieznana trasa" } };
    const body = (input.body ?? {}) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message : "";
    try {
      const result: any = await sendFromAgent(
        ctx,
        input.routeKey,
        { issueId: input.params.issueId, message },
        { companyId: input.companyId, agentId: input.actor.agentId ?? input.actor.actorId },
      );
      if (result.error) return { status: 400, body: { ok: false, error: result.error } };
      return { status: 200, body: { ok: true, ...result.data, info: result.content } };
    } catch (err) {
      ctx.logger.error("Błąd wysyłki WhatsApp z trasy API", { error: String(err), route: input.routeKey });
      return { status: 502, body: { ok: false, error: String(err) } };
    }
  },

  async onValidateConfig(config) {
    const s = readSettings(config);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!/^https?:\/\//.test(s.evolutionUrl)) errors.push("Adres Evolution musi zaczynać się od http:// lub https://");
    if (!config.evolutionApiKey) errors.push("Wybierz sekret z kluczem API Evolution");
    if (!s.instanceName) errors.push("Podaj nazwę instancji Evolution");
    if (s.allowedNumbers.length === 0) warnings.push("Brak uprawnionych numerów — wszystkie odpowiedzi z WhatsApp będą pomijane");
    return { ok: errors.length === 0, errors, warnings };
  },

  async onHealth() {
    return { status: "ok", message: "WhatsApp (Evolution API) gotowy" };
  },
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default plugin;
runWorker(plugin, import.meta.url);
