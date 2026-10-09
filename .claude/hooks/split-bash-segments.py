#!/usr/bin/env python3
"""
Разбор команды Bash на сегменты (по ; && || |) и слова в каждом сегменте,
с учётом кавычек и экранирования — для guard-enterprise.sh.

Используется python3/shlex вместо `set -- $seg`, который ломает пути с
пробелами в кавычках ('/dir with space') на отдельные слова.

Вход: команда Bash на stdin.
Выход: JSON-массив сегментов, каждый —
  {"error": false, "tokens": [...]}           — разобран успешно
  {"error": true, "raw": "<исходный текст>"}  — не удалось разобрать
    (непарные кавычки); вызывающий решает fail-closed/open по содержимому.
"""
import sys
import shlex
import json


def split_segments(s):
    """Разбить на сегменты по ; && || | / \\n, не трогая то, что в кавычках."""
    segs = []
    cur = []
    i = 0
    n = len(s)
    quote = None  # None | "'" | '"'
    while i < n:
        c = s[i]
        if quote:
            cur.append(c)
            if quote == '"' and c == '\\' and i + 1 < n:
                cur.append(s[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            cur.append(c)
            i += 1
            continue
        if c == '\\' and i + 1 < n:
            cur.append(c)
            cur.append(s[i + 1])
            i += 2
            continue
        if c == '|' and i + 1 < n and s[i + 1] == '|':
            segs.append(''.join(cur)); cur = []; i += 2; continue
        if c == '&' and i + 1 < n and s[i + 1] == '&':
            segs.append(''.join(cur)); cur = []; i += 2; continue
        if c in (';', '|', '\n'):
            segs.append(''.join(cur)); cur = []; i += 1; continue
        cur.append(c)
        i += 1
    segs.append(''.join(cur))
    return segs


def main():
    cmd = sys.stdin.read()
    out = []
    for seg in split_segments(cmd):
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            out.append({"error": True, "raw": seg})
            continue
        if not tokens:
            continue
        out.append({"error": False, "tokens": tokens})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
