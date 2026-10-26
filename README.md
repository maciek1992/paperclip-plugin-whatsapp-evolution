# Paperclip plugin — WhatsApp via Evolution API

Two-way WhatsApp conversations between [Paperclip](https://paperclip.ing) agents and humans, using a self-hosted [Evolution API](https://github.com/EvolutionAPI/evolution-api) v2 instance.

> 🇵🇱 **PL:** Agenci Paperclip rozmawiają z ludźmi w grupie WhatsApp. Agent pyta, człowiek odpowiada swobodnie na telefonie, a odpowiedź wraca do zadania jako komentarz człowieka i budzi agenta. Interfejs pluginu i instrukcje dla agentów są po polsku.

## What it does

- **Agent asks, human answers in plain language.** An agent posts a question to a WhatsApp group (e.g. *"Article ready — publish today at 18:00?"*) and ends its run. No polling, no tokens burned while waiting.
- **The reply wakes the agent.** The human replies in WhatsApp however they like (*"yes, but change the title"*). The plugin adds the reply to the originating Paperclip issue **as a comment from that human**. Paperclip wakes the assigned agent the same way it does for a board comment, so the agent reads the full context and continues, or asks again.
- **New requests from WhatsApp.** A message that isn't a reply to anything opens a new issue assigned to a configurable agent (e.g. `CEO`).
- **Acknowledgement.** An emoji reaction (👀), or a short quoted text reply, confirms the message was picked up.
- **Agent skill included.** The plugin installs a managed company skill, *"WhatsApp — rozmowa z ludźmi"*, with instructions and a `scripts/whatsapp.sh` helper.

```
Agent ── whatsapp.sh ask ──▶ plugin API route ──▶ Evolution API ──▶ WhatsApp group
  ▲                                                                       │
  └── wakes on human comment ◀── issue comment (as human) ◀── plugin webhook ◀┘
```

### Routing a reply to an issue

1. A **quoted reply** to the agent's message: exact match by WhatsApp message id.
2. An `[ACME-12]` tag in the quoted text or in the message.
3. Without a quote: the agent's latest open question from the last *N* hours (default 12).
4. Otherwise: a new issue for the configured agent (or ignored, if no agent is set).

## Security

- Only one group is accepted, and only messages from **allow-listed phone numbers**. Senders are identified by `participantAlt`, so this works with WhatsApp's anonymous `@lid` group addressing.
- **Webhook authentication.** Evolution includes the instance API key in every webhook body. The plugin compares it in constant time with the key stored as a Paperclip secret. If they don't match (e.g. you configured the global key), the message is verified with `POST /chat/findMessages` using the plugin's own key. Forged webhooks are rejected.
- **Idempotent.** Each message is processed once. Issues created from messages are deduplicated by `originId`, which survives plugin reinstalls.
- **The Evolution key is only a Paperclip `secret_ref`.** It is never logged or written to plugin state.
- Replies are attributed to a human company member, so the host verifies that member exists before posting.

## Requirements

- Paperclip with the plugin runtime (tested on `2026.1023.0`, plugin API v1).
- Evolution API v2 (tested on `2.3.7`) with a connected WhatsApp instance that is a **member of the target group**.
- Agents run with `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_TASK_ID` in their environment (standard for local adapters such as `claude_local`), plus `curl` and `jq` or `python3`.

## Install

Download `whatsapp-evolution-<version>.tgz` from [Releases](../../releases), then unpack it on the Paperclip host:

```bash
mkdir -p ~/plugins && tar -xzf whatsapp-evolution-0.2.2.tgz -C ~/plugins
```

The **Install Plugin** dialog only accepts npm packages, so install from the local path through the API. Run this in the browser console on your Paperclip page as an instance admin:

```js
fetch('/api/plugins/install', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
  body: JSON.stringify({packageName:'/home/<user>/plugins/whatsapp-evolution', isLocalPath:true})})
  .then(r => r.json()).then(console.log)
```

Upgrade later with `POST /api/plugins/<pluginId>/upgrade`.

### Configure

**Settings → Plugins → WhatsApp (Evolution API):**

| Setting | Example |
|---|---|
| Evolution API URL | `http://192.168.1.50:8080` (direct, not through a reverse proxy) |
| Evolution API key | pick a company **secret** holding the instance key |
| Instance name | `wa-main` |
| Group name / group JID | `Agent` / `1203…@g.us` |
| Allowed numbers | `48600123456` |
| Agent for new requests | `CEO` (empty = don't create issues) |
| Acknowledgement | `👀` (emoji = reaction, text = quoted reply, empty = none) |

Then:

1. **Evolution → instance → Events → Webhook:** enable it, set the URL to `http://<paperclip-host>:3100/api/plugins/local.whatsapp-evolution/webhooks/evolution`, and select the `MESSAGES_UPSERT` event.
2. **Agent → Skills:** enable *"WhatsApp — rozmowa z ludźmi"*. No tool profile is required.

## How agents use it

The installed skill tells the agent to run:

```bash
bash ./scripts/whatsapp.sh ask    "Article *How to pick a CRM* is ready. Publish today at 18:00?"
bash ./scripts/whatsapp.sh notify "✅ Published: https://example.com/crm"
```

The script calls the plugin's scoped API routes with the agent's own key:

- `POST /api/plugins/local.whatsapp-evolution/api/issues/:issueId/ask`
- `POST /api/plugins/local.whatsapp-evolution/api/issues/:issueId/notify`

Body: `{"message": "…"}`. The routes also accept board sessions.

## Paperclip quirks handled (2026.1023)

- **`ctx.http.fetch` blocks private IP ranges** (SSRF guard), which makes an Evolution server on your LAN unreachable through it. The worker connects with Node's `fetch`, but **only** to the admin-configured Evolution URL.
- **The plugin config validator (ajv strict) rejects `x-paperclip-advanced`,** even though the SDK types allow it, so the plugin doesn't use it.
- **Plugin tools are not exposed to agents** without a tool profile, and `/api/plugins/tools/execute` requires a `projectId`. Agents therefore use scoped API routes. The `ask`/`notify` tools are still registered.
- **An upgrade that adds capabilities fails with 400,** and there is no approval endpoint yet. Uninstall (`DELETE /api/plugins/:id`) and install again; the configuration is kept.
- **The managed skill is installed when the worker starts** (`skills.managed.reconcile`) and is reset when the plugin version changes.

## Development

```bash
npm install
npm test        # build + 28 tests
```

Tests cover parsing of real (anonymised) Evolution 2.3.7 webhook payloads, the ask → reply → comment flow, deduplication, forged-webhook rejection, acknowledgements, API routes, the managed skill, and validation of the config schema with the same ajv setup as the Paperclip server. The flow tests run in the official SDK test harness (`@paperclipai/plugin-sdk/testing`) against a fake Evolution API.

```
src/
  manifest.ts   plugin manifest (capabilities, config schema, webhook, API routes, tools, skill)
  worker.ts     webhook handling, routing, Evolution client, API routes, tools
  core.ts       pure logic (parsing, settings, formatting)
  skill.ts      managed agent skill (SKILL.md)
  whatsapp.sh   helper script shipped with the skill
```

## License

[MIT](LICENSE)
