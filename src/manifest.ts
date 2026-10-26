import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { AGENT_SKILL_MARKDOWN, WHATSAPP_SCRIPT } from "./skill.js";

export const PLUGIN_ID = "local.whatsapp-evolution";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.2",
  displayName: "WhatsApp (Evolution API)",
  description:
    "Agenci rozmawiają z ludźmi w grupie WhatsApp przez Evolution API: zadają pytania, a odpowiedzi wracają do zadania jako komentarz człowieka i budzą agenta. Wiadomości spoza wątków mogą zakładać nowe zadania.",
  author: "Maciej Kmiecik",
  categories: ["connector"],
  capabilities: [
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
    "access.members.read",
    "plugin.state.read",
    "plugin.state.write",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "api.routes.register",
    "activity.log.write",
    "skills.managed",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      evolutionUrl: {
        type: "string",
        title: "Adres Evolution API",
        description: "Np. http://192.168.1.50:8080 — bezpośrednio, bez reverse proxy.",
        default: "http://localhost:8080",
      },
      evolutionApiKey: {
        format: "secret-ref",
        title: "Klucz API Evolution (sekret)",
        description: "Klucz instancji WhatsApp z managera Evolution, zapisany jako sekret firmy.",
      },
      instanceName: {
        type: "string",
        title: "Nazwa instancji Evolution",
      },
      groupName: {
        type: "string",
        title: "Nazwa grupy WhatsApp",
        description: "Grupa, w której agenci rozmawiają z ludźmi. Numer instancji musi być jej członkiem.",
        default: "Agent",
      },
      groupJid: {
        type: "string",
        title: "Identyfikator grupy (opcjonalnie)",
        description: "…@g.us — jeśli ustawiony, nazwa grupy jest ignorowana (odporne na zmianę nazwy).",
      },
      allowedNumbers: {
        type: "array",
        title: "Numery uprawnione do odpowiadania",
        description: "Numery z kierunkowym, bez + i spacji, np. 48600123456. Wiadomości od innych osób w grupie są pomijane.",
        items: { type: "string" },
        default: [],
      },
      replyAsUserId: {
        type: "string",
        title: "ID użytkownika Paperclip, w imieniu którego wpisywane są odpowiedzi",
        description: "Odpowiedź z WhatsApp trafia do zadania jako komentarz tego człowieka (to budzi agenta). Puste = właściciel firmy.",
      },
      defaultAgentName: {
        type: "string",
        title: "Agent dla nowych spraw",
        description: "Wiadomość niebędąca odpowiedzią na pytanie agenta zakłada zadanie przypisane do tego agenta (nazwa, np. CEO). Puste = nie zakładaj zadań.",
        default: "CEO",
      },
      replyWindowHours: {
        type: "number",
        title: "Ile godzin wiadomość bez cytatu liczy się jako odpowiedź na ostatnie pytanie",
        default: 12,
      },
      ackReaction: {
        type: "string",
        title: "Potwierdzenie odbioru wiadomości",
        description: "Jedno emoji (np. 👀) = reakcja pod wiadomością; tekst (np. przyjąłem) = krótka odpowiedź z cytatem; puste = bez potwierdzenia.",
        default: "👀",
      },
    },
    required: ["evolutionUrl", "instanceName"],
  },
  apiRoutes: [
    {
      routeKey: "ask",
      method: "POST",
      path: "/issues/:issueId/ask",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: "notify",
      method: "POST",
      path: "/issues/:issueId/notify",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
  ],
  webhooks: [
    {
      endpointKey: "evolution",
      displayName: "Evolution API — wiadomości",
      description: "Ustaw w Evolution (Events → Webhook) z zdarzeniem MESSAGES_UPSERT.",
    },
  ],
  tools: [
    {
      name: "ask",
      displayName: "Zapytaj człowieka na WhatsApp",
      description:
        "Zadaj człowiekowi pytanie w grupie WhatsApp, gdy potrzebujesz decyzji, akceptacji lub informacji. Po wysłaniu ZAKOŃCZ bieżący run — odpowiedź przyjdzie jako komentarz w tym zadaniu i obudzi cię ponownie. Pisz naturalnie, krótko, z kontekstem.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Identyfikator bieżącego zadania, np. ACME-12 (albo UUID)." },
          message: { type: "string", description: "Treść pytania. Formatowanie WhatsApp: *pogrubienie*, _kursywa_." },
        },
        required: ["issueId", "message"],
      },
    },
    {
      name: "notify",
      displayName: "Wyślij informację na WhatsApp",
      description:
        "Wyślij do grupy WhatsApp informację, na którą nie czekasz z odpowiedzią (zakończenie zadania, alert). Jeśli człowiek mimo to odpowie, odpowiedź trafi do wskazanego zadania.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Identyfikator zadania, którego dotyczy wiadomość (zalecany)." },
          message: { type: "string", description: "Treść wiadomości." },
        },
        required: ["message"],
      },
    },
  ],
  skills: [
    {
      skillKey: "whatsapp-conversation",
      displayName: "WhatsApp — rozmowa z ludźmi",
      slug: "whatsapp-conversation",
      description:
        "Use when you need a human decision, approval or missing information, or want to notify humans about important progress. Don't use for routine status that belongs in issue comments.",
      markdown: AGENT_SKILL_MARKDOWN,
      files: [{ path: "scripts/whatsapp.sh", content: WHATSAPP_SCRIPT }],
    },
  ],
};

export default manifest;
