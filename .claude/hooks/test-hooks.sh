#!/bin/bash
# Скриптовые тесты guard-enterprise.sh (ADR-003, clean-room). Запуск:
# bash .claude/hooks/test-hooks.sh
# Фикстуры — во временной папке с пробелом в пути, НЕ файлы Twenty.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
FX=$(mktemp -d)
trap 'rm -rf "$FX"' EXIT
mkdir -p "$FX/repo/ent" "$FX/repo/oss" "$FX/repo/dir with space"
printf '/* @license Enterprise */\nsecret\n' > "$FX/repo/ent/rls.ts"
printf 'export const a = 1;\n' > "$FX/repo/oss/a.ts"
printf '/* @license Enterprise */\nsecret\n' > "$FX/repo/dir with space/ent.ts"
printf 'export const b = 1;\n' > "$FX/repo/dir with space/plain.ts"
git -C "$FX/repo" init -q && git -C "$FX/repo" add -A && git -C "$FX/repo" -c user.email=t@t -c user.name=t commit -qm x
FAIL=0
chk() { # имя ожидание json
  d=$(printf '%s' "$3" | CLAUDE_PROJECT_DIR=$PWD ".claude/hooks/guard-enterprise.sh" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null); d=${d:-allow}
  if [ "$d" = "$2" ]; then echo "✓ $1"; else echo "✗ $1: $d, ожидалось $2"; FAIL=1; fi
}
b() { jq -n --arg c "$1" --arg w "$FX" '{tool_name:"Bash",cwd:$w,tool_input:{command:$c}}'; }
f() { jq -n --arg t "$1" --arg p "$2" --arg m "${3:-}" '{tool_name:$t,cwd:"/tmp",tool_input:{file_path:$p,path:$p,output_mode:$m}}'; }
E="$FX/repo/ent/rls.ts"; O="$FX/repo/oss/a.ts"
EWS="$FX/repo/dir with space/ent.ts"; OWS="$FX/repo/dir with space/plain.ts"
DWS="$FX/repo/dir with space"

chk "Read enterprise"        deny  "$(f Read "$E")"
chk "Read обычного"          allow "$(f Read "$O")"
chk "Read самого хука"       allow "$(f Read "$PWD/.claude/hooks/guard-enterprise.sh")"
chk "Grep content файл"      deny  "$(f Grep "$E" content)"
chk "Grep content папка"     deny  "$(f Grep "$FX/repo" content)"
chk "Grep имена папка"       allow "$(f Grep "$FX/repo" files_with_matches)"
chk "cat enterprise"         deny  "$(b "cat $E")"
chk "head -5"                allow "$(b "head -5 $E | grep -q x")"
chk "head -n -5"             deny  "$(b "head -n -5 $E")"
chk "grep -C"                deny  "$(b "grep -C 9 x $E")"
chk "grep -rL папка"         allow "$(b "grep -rL '@license Enterprise' $FX/repo")"
chk "grep -rn папка"         deny  "$(b "grep -rn x $FX/repo")"
chk "cd && cat"              deny  "$(b "cd repo && cat ent/rls.ts")"
chk "git show HEAD:path"     deny  "$(b "git -C repo show HEAD:ent/rls.ts")"
chk "cat обычного"           allow "$(b "cat $O")"

# пути с пробелом в кавычках (регрессия на `set -- $seg`)
chk "cat путь с пробелом"              deny  "$(b "cat '$EWS'")"
chk "grep -rn папка с пробелом"        deny  "$(b "grep -rn x '$DWS'")"
chk "cd папка с пробелом && grep -rn ." deny "$(b "cd '$DWS' && grep -rn x .")"
chk "head -n 3 путь с пробелом"        allow "$(b "head -n 3 '$EWS'")"
chk "grep -rl папка с пробелом"        allow "$(b "grep -rl x '$DWS'")"
chk "cat обычный путь с пробелом"      allow "$(b "cat '$OWS'")"

# fail-closed/open на непарных кавычках
chk "непарная кавычка + onema-twenty"    deny  "$(b "cat 'onema-twenty/ent/rls.ts")"
chk "непарная кавычка без onema-twenty"  allow "$(b "cat 'oss/a.ts")"

[ $FAIL -eq 0 ] && echo "хуки: зелёный" || echo "хуки: КРАСНЫЙ"
exit $FAIL
