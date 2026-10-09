#!/bin/bash
# Clean-room (ADR-003): файлы Twenty с шапкой `@license Enterprise` под
# коммерческой лицензией — не открываем. Разрешено только узнать, что файл
# такой: `head -n 1..5` и grep с -l/-L/-c (имена, не текст).
# Это ремень безопасности, не граница: переменные, глобы, интерпретаторы
# (python/node -e) хук не разбирает — основное правило в CLAUDE.md.
set -uo pipefail
command -v jq >/dev/null || { echo "guard-enterprise: нет jq" >&2; exit 2; }
HOOKDIR=$(cd "$(dirname "$0")" && pwd)
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty'); [ -n "$CWD" ] && cd "$CWD" 2>/dev/null
# Шапка Twenty: `/* @license Enterprise */` или ` * @license Enterprise` в начале строки.
ENT_RE='^[[:space:]]*(/\*+|\*)[[:space:]]*@license Enterprise'
is_ent() { [ -f "$1" ] && head -5 "$1" 2>/dev/null | grep -qE "$ENT_RE"; }
dir_has_ent() { [ -d "$1" ] && grep -rlqE --include='*.ts' --include='*.tsx' "$ENT_RE" "$1" 2>/dev/null; }
deny() {
  jq -n --arg r "Clean-room (ADR-003): $1. Файлы Twenty под лицензией Enterprise не открывать и не копировать; искать только в списке grep -rL '@license Enterprise'." \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
case "$TOOL" in
  Read|Edit|Write|NotebookEdit)
    F=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty')
    [ -n "$F" ] && is_ent "$F" && deny "$F" ;;
  Grep)
    P=$(printf '%s' "$INPUT" | jq -r '.tool_input.path // "."')
    M=$(printf '%s' "$INPUT" | jq -r '.tool_input.output_mode // "files_with_matches"')
    if [ "$M" = content ]; then
      is_ent "$P" && deny "Grep по $P"
      dir_has_ent "$P" && deny "Grep с выводом текста по папке $P, где есть Enterprise-файлы"
    fi ;;
  Bash)
    CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
    set -f
    # Разбор через python3/shlex (а не `set -- $seg`): учитывает кавычки и
    # экранированные пробелы, так что '/dir with space' не ломается на слова.
    SEGS_JSON=$(printf '%s' "$CMD" | python3 "$HOOKDIR/split-bash-segments.py" 2>/dev/null)
    if ! printf '%s' "$SEGS_JSON" | jq -e . >/dev/null 2>&1; then
      # python3/shlex не отработал — fail-closed только если команда упоминает форк.
      case "$CMD" in *onema-twenty*) deny "не удалось разобрать команду (python3/shlex недоступен), команда касается форка onema-twenty" ;; esac
      SEGS_JSON='[]'
    fi
    SEG_COUNT=$(printf '%s' "$SEGS_JSON" | jq 'length' 2>/dev/null); SEG_COUNT=${SEG_COUNT:-0}
    i=0
    while [ "$i" -lt "$SEG_COUNT" ]; do
      SEG=$(printf '%s' "$SEGS_JSON" | jq -c ".[$i]")
      i=$((i + 1))
      if [ "$(printf '%s' "$SEG" | jq -r '.error')" = true ]; then
        RAW=$(printf '%s' "$SEG" | jq -r '.raw')
        case "$RAW" in
          *onema-twenty*) deny "не удалось разобрать сегмент команды (непарные кавычки) рядом с форком onema-twenty: $RAW" ;;
        esac
        continue
      fi
      WORDS=()
      while IFS= read -r w; do WORDS+=("$w"); done < <(printf '%s' "$SEG" | jq -r '.tokens[]')
      [ "${#WORDS[@]}" -eq 0 ] && continue
      set -- "${WORDS[@]}"
      case "$1" in
        cd) cd "${2:-$HOME}" 2>/dev/null; continue ;;
        git) [ "${2:-}" = -C ] && cd "${3:-.}" 2>/dev/null ;;
        head)
          N=""
          case "${2:-}" in
            -n) N="${3:-}" ;;
            -n*) N="${2#-n}" ;;
            -[1-5]) N="${2#-}" ;;
          esac
          case "$N" in [1-5]) continue ;; esac ;;
        grep|rg|egrep)
          names=0; ctx=0
          for a in "$@"; do
            case "$a" in
              --files-with-matches|--files-without-match|--count) names=1 ;;
              --*) ;;
              -*) case "$a" in *[ABCo]*) ctx=1 ;; esac   # контекст или -o печатают текст
                  case "$a" in *[lLc]*) names=1 ;; esac ;;
            esac
          done
          [ $names -eq 1 ] && [ $ctx -eq 0 ] && continue
          shift
          for a in "$@"; do
            dir_has_ent "$a" && deny "grep с выводом текста по папке $a, где есть Enterprise-файлы"
          done
          set -- "${WORDS[@]}" ;;
      esac
      for a in "$@"; do
        case "$a" in *:*) b="${a#*:}"; is_ent "$b" && deny "$a (через git)" ;; esac
        is_ent "$a" && deny "$a"
      done
    done ;;
esac
exit 0
