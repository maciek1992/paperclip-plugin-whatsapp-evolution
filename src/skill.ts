import script from "./whatsapp.sh";

export const WHATSAPP_SCRIPT: string = script;

export const AGENT_SKILL_MARKDOWN = `---
name: WhatsApp — rozmowa z ludźmi
description: Use when you need a human decision, approval or missing information, or want to notify humans about important progress via WhatsApp. Don't use for routine status that belongs in issue comments.
slug: whatsapp-conversation
---

# WhatsApp — rozmowa z ludźmi

Ludzie czytają grupę WhatsApp na telefonie i odpowiadają tam naturalnym językiem.
Piszesz do nich skryptem \`scripts/whatsapp.sh\` z katalogu tego skilla (plugin WhatsApp / Evolution API).
Skrypt sam bierze adres Paperclip, klucz, bieżące zadanie i run z twojego środowiska.

\`\`\`bash
bash ./scripts/whatsapp.sh ask    "Artykuł *Jak wybrać CRM* gotowy (1800 słów). Publikuję dziś o 18:00?"
bash ./scripts/whatsapp.sh notify "✅ Opublikowane: https://example.com/crm"
\`\`\`

Opcjonalnie \`--issue ACME-12\` na końcu — domyślnie bieżące zadanie. Formatowanie WhatsApp: \`*pogrubienie*\`, \`_kursywa_\`.

## Kiedy pytać (\`ask\`)

- Gdy masz wątpliwość, której nie rozstrzygniesz sam: decyzja biznesowa, akceptacja przed
  nieodwracalną akcją (publikacja, wysyłka do klienta, usunięcie, wydatek), brakująca informacja.
- Pisz jak do szefa na komunikatorze: krótko, z kontekstem i z propozycją.
- Jedno pytanie = jedna wiadomość. Nie zasypuj grupy.
- **Po wysłaniu pytania zakończ run.** Nie czekaj w pętli i nie odpytuj. Odpowiedź przyjdzie jako
  komentarz człowieka w zadaniu i automatycznie cię obudzi.

## Gdy wrócisz z odpowiedzią

- Odpowiedź z WhatsApp ma w komentarzu prefiks „💬 WhatsApp". Interpretuj ją swobodnie, w kontekście
  pytania i zadania („ok", „tak, ale zmień tytuł", „wstrzymaj się do piątku").
- Jeśli jest niejasna — dopytaj kolejnym \`ask\`.
- Po wykonaniu akcji krótko potwierdź przez \`notify\`.

## Zlecenia z WhatsApp

Zadanie z tytułem „WhatsApp: …" założył człowiek, pisząc w grupie. Wykonaj je, a wynik lub pytanie
odeślij przez \`notify\` / \`ask\` — człowiek czeka na odpowiedź na WhatsApp, nie w panelu.

## Informacje bez pytania (\`notify\`)

- Wynik zlecenia z WhatsApp, zakończenie ważnego zadania, błąd blokujący pracę, alert.
- Nie wysyłaj rutynowych statusów — te zapisuj w komentarzach zadania.

## Zasady

- Nigdy nie wysyłaj haseł, tokenów, kluczy API ani danych osobowych spoza zadania.
- Nie używaj starych sposobów wysyłki (skrypty z kluczem Evolution, curl do Evolution) — tylko ten skrypt.
- Kod wyjścia ≠ 0: wklej komunikat błędu do komentarza zadania i nie ponawiaj w pętli.
`;
