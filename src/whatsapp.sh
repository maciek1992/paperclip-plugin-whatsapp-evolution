#!/usr/bin/env bash
# WhatsApp (Evolution API) — wysyłka z poziomu agenta Paperclip przez trasę API pluginu.
#
#   ./scripts/whatsapp.sh ask    "<pytanie>"   # pytanie; odpowiedź wróci jako komentarz w zadaniu
#   ./scripts/whatsapp.sh notify "<treść>"     # informacja bez czekania na odpowiedź
#   opcjonalnie na końcu: --issue <ACME-12 albo UUID>   (domyślnie bieżące zadanie: $PAPERCLIP_TASK_ID)
#
# Kody wyjścia: 0 OK, 1 złe użycie, 2 brak kontekstu runu, 3 błąd API/pluginu.
set -euo pipefail

usage() { echo 'Użycie: whatsapp.sh ask|notify "<treść>" [--issue <id>]' >&2; exit 1; }

[ $# -ge 2 ] || usage
cmd="$1"; msg="$2"; shift 2
case "$cmd" in ask|notify) ;; *) usage ;; esac
[ -n "${msg// /}" ] || { echo "BŁĄD: pusta treść" >&2; exit 1; }

issue="${PAPERCLIP_TASK_ID:-}"
if [ "${1:-}" = "--issue" ]; then issue="${2:-}"; fi

for v in PAPERCLIP_API_URL PAPERCLIP_API_KEY; do
  [ -n "${!v:-}" ] || { echo "BŁĄD: brak zmiennej $v — uruchamiaj w runie agenta Paperclip" >&2; exit 2; }
done
[ -n "$issue" ] || { echo "BŁĄD: brak zadania — podaj --issue <id> albo uruchom w runie z PAPERCLIP_TASK_ID" >&2; exit 2; }

base="${PAPERCLIP_API_URL%/}"
base="${base%/api}"
url="$base/api/plugins/local.whatsapp-evolution/api/issues/$issue/$cmd"

if command -v jq >/dev/null 2>&1; then
  body="$(jq -n --arg m "$msg" '{message: $m}')"
else
  body="$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1]}))' "$msg")"
fi

headers=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json")
[ -n "${PAPERCLIP_RUN_ID:-}" ] && headers+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")

resp="$(curl -sS --max-time 60 -w $'\n%{http_code}' -X POST "$url" "${headers[@]}" --data "$body")" \
  || { echo "BŁĄD: brak połączenia z $base" >&2; exit 3; }
code="${resp##*$'\n'}"
payload="${resp%$'\n'*}"

if [ "$code" = "200" ] || [ "$code" = "201" ]; then
  echo "$payload"
  exit 0
fi
echo "BŁĄD (HTTP $code): $payload" >&2
exit 3
