// Pełny przepływ w testowym hoście SDK z podstawionym Evolution API.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../dist/worker.js";
import manifest from "../dist/manifest.js";

const GROUP = "120363000000000001@g.us";
const CO = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const USER = "user-owner-1";
const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/upsert-${n}.json`, import.meta.url), "utf8"));

let harness;
let evo; // log wywołań fake Evolution
let botSeq;
let findMessagesRecords;

function installFakeEvolution() {
  evo = [];
  botSeq = 0;
  findMessagesRecords = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    evo.push({ path: u.pathname, body, apikey: init.headers?.apikey });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.startsWith("/group/fetchAllGroups/")) return json([{ id: "999@g.us", subject: "Inna" }, { id: GROUP, subject: "Agent" }]);
    if (u.pathname.startsWith("/message/sendText/")) return json({ key: { id: `BOT${++botSeq}`, remoteJid: body.number, fromMe: true } }, 201);
    if (u.pathname.startsWith("/message/sendReaction/")) return json({ ok: true }, 201);
    if (u.pathname.startsWith("/chat/findMessages/")) return json({ messages: { records: findMessagesRecords } });
    return json({ error: "not found" }, 404);
  };
}

const KEY_REF = "sec-evolution";
const RESOLVED_KEY = () => "resolved:[object Object]"; // harness SDK zwraca `resolved:${ref}` dla obiektu secret_ref

async function setup(configOverrides = {}) {
  installFakeEvolution();
  harness = createTestHarness({
    manifest,
    config: {
      evolutionUrl: "http://evo.test:8080",
      evolutionApiKey: KEY_REF,
      instanceName: "wa-main",
      groupName: "Agent",
      allowedNumbers: ["48500100200"],
      defaultAgentName: "CEO",
      ...configOverrides,
    },
  });
  harness.seed({
    companies: [{ id: CO, name: "ACME", issuePrefix: "ACME" }],
    agents: [{ id: AGENT, companyId: CO, name: "CEO", status: "idle" }],
    issues: [{ id: ISSUE, companyId: CO, identifier: "ACME-12", title: "Artykuł xyz", status: "in_progress", assigneeAgentId: AGENT }],
    accessMembers: [{ id: "m1", companyId: CO, principalType: "user", principalId: USER, status: "active", membershipRole: "owner", grants: [] }],
  });
  await plugin.definition.setup(harness.ctx);
}

function webhookFrom(n, patch = {}) {
  const body = fixture(n);
  body.apikey = RESOLVED_KEY();
  Object.assign(body.data.key, patch.key ?? {});
  if (patch.contextInfo) body.data.contextInfo = { ...(body.data.contextInfo ?? {}), ...patch.contextInfo };
  if (patch.noContext) delete body.data.contextInfo;
  if (patch.text !== undefined) body.data.message = { conversation: patch.text };
  if (patch.apikey !== undefined) body.apikey = patch.apikey;
  return body;
}

const deliver = (body) =>
  plugin.definition.onWebhook({ endpointKey: "evolution", headers: {}, rawBody: JSON.stringify(body), parsedBody: body, requestId: crypto.randomUUID() });

const comments = () => harness.ctx.issues.listComments(ISSUE, CO);

beforeEach(async () => setup());

test("ask: wysyła pytanie do grupy z oznaczeniem zadania", async () => {
  const res = await harness.executeTool("ask", { issueId: "ACME-12", message: "Publikować artykuł xyz dziś o 18?" }, { companyId: CO, agentId: AGENT });
  assert.equal(res.error, undefined);
  const send = evo.find((c) => c.path === "/message/sendText/wa-main");
  assert.equal(send.body.number, GROUP);
  assert.equal(send.body.text, "[ACME-12] Publikować artykuł xyz dziś o 18?");
  assert.match(res.content, /Zakończ teraz run/);
});

test("odpowiedź z cytatem trafia do zadania jako komentarz człowieka (budzi agenta) + reakcja", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "Publikować?" }, { companyId: CO, agentId: AGENT });
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, text: undefined }));
  const c = await comments();
  assert.equal(c.length, 1);
  assert.match(c[0].body, /test 2 odpowiedź/);
  assert.match(c[0].body, /💬 WhatsApp — Jan \(\+48500100200\)/);
  assert.equal(c[0].authorType, "user", "komentarz człowieka, nie agenta/pluginu — tylko taki budzi przypisanego agenta");
  assert.equal(c[0].authorUserId, USER);
  assert.ok(evo.some((x) => x.path === "/message/sendReaction/wa-main"), "reakcja 👀");
});

test("ten sam webhook dwa razy = jeden komentarz", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  const body = webhookFrom(2, { contextInfo: { stanzaId: "BOT1" } });
  await deliver(body);
  await deliver(body);
  assert.equal((await comments()).length, 1);
});

test("wiadomość bez cytatu w oknie czasowym trafia do ostatniego pytania", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "Który tytuł?" }, { companyId: CO, agentId: AGENT });
  await deliver(webhookFrom(1, { text: "ten drugi, ale bez wykrzyknika" }));
  const c = await comments();
  assert.equal(c.length, 1);
  assert.match(c[0].body, /ten drugi/);
});

test("nieuprawniony numer jest pomijany", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, key: { participantAlt: "48777666555@s.whatsapp.net" } }));
  assert.equal((await comments()).length, 0);
});

test("inna grupa i własne wiadomości są pomijane", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, key: { remoteJid: "999@g.us" } }));
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, key: { fromMe: true } }));
  assert.equal((await comments()).length, 0);
});

test("podrobiony webhook (zły klucz, Evolution nie zna wiadomości) jest odrzucany", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  findMessagesRecords = [];
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, apikey: "zly-klucz" }));
  assert.equal((await comments()).length, 0);
});

test("zły klucz w webhooku, ale Evolution potwierdza wiadomość (klucz globalny) → przyjęte", async () => {
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  const body = webhookFrom(2, { contextInfo: { stanzaId: "BOT1" }, apikey: "" });
  findMessagesRecords = [{ key: { id: body.data.key.id, remoteJid: GROUP } }];
  await deliver(body);
  assert.equal((await comments()).length, 1);
});

test("nowa sprawa bez kontekstu zakłada zadanie dla agenta CEO", async () => {
  await deliver(webhookFrom(1, { noContext: true, text: "Przygotuj raport SEO dla klienta ABC na piątek" }));
  const issues = await harness.ctx.issues.list({ companyId: CO });
  const created = issues.find((i) => i.id !== ISSUE);
  assert.ok(created, "zadanie założone");
  assert.equal(created.assigneeAgentId, AGENT);
  assert.match(created.title, /^WhatsApp: Przygotuj raport SEO/);
  assert.equal((await comments()).length, 0, "nie dopisano do istniejącego zadania");
});

test("ponowne doręczenie po utracie stanu (reinstalacja) nie zakłada drugiego zadania", async () => {
  const body = webhookFrom(1, { noContext: true, text: "Zrób audyt strony klienta XYZ" });
  await deliver(body);
  // symulacja reinstalacji: stan pluginu wyczyszczony, Evolution ponawia ten sam webhook
  await harness.ctx.state.delete({ scopeKind: "company", scopeId: CO, stateKey: `seen:${body.data.key.id}` });
  await deliver(body);
  const created = (await harness.ctx.issues.list({ companyId: CO })).filter((i) => i.id !== ISSUE);
  assert.equal(created.length, 1, "jedno zadanie mimo dwóch doręczeń");
});

test("reakcja z doklejonym selektorem wariantu jest ponawiana w czystej postaci", async () => {
  await setup({ ackReaction: "👀️" });
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/message/sendReaction/")) {
      const r = JSON.parse(init.body).reaction;
      evo.push({ path: u.pathname, body: { reaction: r } });
      return new Response(JSON.stringify(r === "👀" ? { ok: true } : { message: ["Reaction must be a single emoji or empty string"] }), { status: r === "👀" ? 201 : 400 });
    }
    return real(url, init);
  };
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" } }));
  const sent = evo.filter((c) => c.path === "/message/sendReaction/wa-main").map((c) => c.body.reaction);
  assert.deepEqual(sent, ["👀️", "👀"]);
  assert.ok(!harness.logs.some((l) => /Nie udało się dodać reakcji/.test(l.message)));
});

test("tekstowe potwierdzenie = odpowiedź z cytatem (nie reakcja), powiązana z zadaniem", async () => {
  await setup({ ackReaction: "przyjąłem" });
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  const body = webhookFrom(2, { contextInfo: { stanzaId: "BOT1" } });
  await deliver(body);
  assert.ok(!evo.some((c) => c.path.startsWith("/message/sendReaction/")), "bez reakcji");
  const ack = evo.filter((c) => c.path === "/message/sendText/wa-main").at(-1);
  assert.equal(ack.body.text, "przyjąłem");
  assert.equal(ack.body.quoted.key.id, body.data.key.id);
  // odpowiedź na potwierdzenie trafia do tego samego zadania
  await deliver(webhookFrom(1, { text: "a jeszcze jedno", contextInfo: { stanzaId: "BOT2" }, key: { id: "NEXT-1" } }));
  assert.equal((await comments()).length, 2);
});

test("emoji w ustawieniu = reakcja", async () => {
  await setup({ ackReaction: "✅" });
  await harness.executeTool("ask", { issueId: "ACME-12", message: "?" }, { companyId: CO, agentId: AGENT });
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: "BOT1" } }));
  const r = evo.find((c) => c.path === "/message/sendReaction/wa-main");
  assert.equal(r.body.reaction, "✅");
});

test("pusta nazwa agenta = nie zakładaj nowych spraw", async () => {
  await setup({ defaultAgentName: "" });
  await deliver(webhookFrom(1, { noContext: true, text: "coś nowego" }));
  const issues = await harness.ctx.issues.list({ companyId: CO });
  assert.equal(issues.length, 1);
});

test("skill pluginu trafia do biblioteki firmy po starcie", async () => {
  await new Promise((r) => setTimeout(r, 700));
  const res = await harness.ctx.skills.managed.get("whatsapp-conversation", CO);
  assert.ok(res, "skill rozwiązany");
  assert.notEqual(res.status, "missing", JSON.stringify(res).slice(0, 300));
  assert.ok(!harness.logs.some((l) => /Nie udało się zainstalować skilla/.test(l.message)), JSON.stringify(harness.logs.filter((l) => l.level !== "info")));
});

test("trasa API ask (dla agenta przez REST) wysyła pytanie i wiąże je z zadaniem", async () => {
  const res = await plugin.definition.onApiRequest({
    routeKey: "ask", method: "POST", path: `/issues/${ISSUE}/ask`, params: { issueId: ISSUE }, query: {},
    body: { message: "Publikować?" }, actor: { actorType: "agent", actorId: AGENT, agentId: AGENT, runId: "run-1" },
    companyId: CO, headers: {},
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.issue, "ACME-12");
  const send = evo.find((c) => c.path === "/message/sendText/wa-main");
  assert.equal(send.body.text, "[ACME-12] Publikować?");
  await deliver(webhookFrom(2, { contextInfo: { stanzaId: res.body.messageId } }));
  assert.equal((await comments()).length, 1, "odpowiedź na pytanie z trasy API wraca do zadania");
});

test("trasa API: pusta treść = 400, nieznana trasa = 404", async () => {
  const base = { method: "POST", params: { issueId: ISSUE }, query: {}, actor: { actorType: "agent", actorId: AGENT, agentId: AGENT }, companyId: CO, headers: {} };
  assert.equal((await plugin.definition.onApiRequest({ ...base, routeKey: "notify", path: "/x", body: { message: "" } })).status, 400);
  assert.equal((await plugin.definition.onApiRequest({ ...base, routeKey: "inne", path: "/x", body: {} })).status, 404);
});

test("skill zawiera skrypt whatsapp.sh", () => {
  const skill = manifest.skills.find((s) => s.skillKey === "whatsapp-conversation");
  const file = skill.files.find((f) => f.path === "scripts/whatsapp.sh");
  assert.match(file.content, /api\/plugins\/local\.whatsapp-evolution\/api\/issues/);
  assert.match(skill.markdown, /bash \.\/scripts\/whatsapp\.sh ask/);
});

test("walidacja ustawień", async () => {
  const bad = await plugin.definition.onValidateConfig({ evolutionUrl: "evo:8080", instanceName: "" });
  assert.equal(bad.ok, false);
  const ok = await plugin.definition.onValidateConfig({ evolutionUrl: "http://evo:8080", instanceName: "W", evolutionApiKey: { type: "secret_ref", secretId: "x" }, allowedNumbers: ["1"] });
  assert.equal(ok.ok, true);
});
