import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseEvolutionWebhook,
  extractIssueRef,
  formatOutgoing,
  readSettings,
  normalizePhone,
  safeEqual,
  newIssueTitle,
  reactionCandidates,
} from "../dist/core.js";

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/upsert-${n}.json`, import.meta.url), "utf8"));

test("parsuje zwykłą wiadomość z grupy (prawdziwy payload Evolution 2.3.7, nadawca ukryty za LID)", () => {
  const m = parseEvolutionWebhook(fixture(1));
  assert.equal(m.instance, "wa-main");
  assert.equal(m.remoteJid, "120363000000000001@g.us");
  assert.equal(m.fromMe, false);
  assert.equal(m.senderPhone, "48500100200", "numer z participantAlt mimo adresowania LID");
  assert.equal(m.senderLid, "11111111111111@lid");
  assert.equal(m.text, "test 1");
  assert.equal(m.quotedMessageId, null);
});

test("parsuje odpowiedź z cytatem: stanzaId = id wiadomości agenta", () => {
  const m = parseEvolutionWebhook(fixture(2));
  assert.equal(m.text, "test 2 odpowiedź");
  assert.equal(m.quotedMessageId, "3EB0AAAAAAAAAAAAAAAA01");
  assert.match(m.quotedText, /\[ACME-12\] Artykuł o CRM/);
});

test("ignoruje inne zdarzenia i śmieci", () => {
  assert.equal(parseEvolutionWebhook({ event: "connection.update", data: {} }), null);
  assert.equal(parseEvolutionWebhook(null), null);
  assert.equal(parseEvolutionWebhook("x"), null);
  const viaUnderscore = parseEvolutionWebhook({ ...fixture(1), event: "MESSAGES_UPSERT" });
  assert.equal(viaUnderscore.text, "test 1");
});

test("oznaczenie zadania i format wiadomości", () => {
  assert.equal(extractIssueRef("[ACME-12] Publikować?"), "ACME-12");
  assert.equal(extractIssueRef("bez oznaczenia"), null);
  assert.equal(formatOutgoing("ACME-12", "  Publikować?  "), "[ACME-12] Publikować?");
  assert.equal(formatOutgoing(null, "Hej"), "Hej");
  assert.ok(newIssueTitle("a".repeat(200)).length <= 81);
});

test("ustawienia: numery normalizowane, domyślne wartości", () => {
  const s = readSettings({ allowedNumbers: ["+48 600-123-456", "48500@s.whatsapp.net"], evolutionUrl: "http://x:8080/" });
  assert.deepEqual(s.allowedNumbers, ["48600123456", "48500"]);
  assert.equal(s.evolutionUrl, "http://x:8080");
  assert.equal(s.groupName, "Agent");
  assert.equal(s.replyWindowHours, 12);
  assert.equal(readSettings({ allowedNumbers: "1, 2" }).allowedNumbers.length, 2);
  assert.equal(normalizePhone("+48 (600) 123-456"), "48600123456");
});

test("reakcja: usuwa selektor wariantu i spacje, które odrzuca Evolution", () => {
  assert.deepEqual(reactionCandidates("👀"), ["👀"]);
  assert.deepEqual(reactionCandidates(" 👀️ "), ["👀️", "👀"]);
  assert.deepEqual(reactionCandidates(""), []);
});

test("porównanie klucza w stałym czasie", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), false);
});
