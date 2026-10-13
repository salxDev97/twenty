/**
 * ONE-107 (Onema). Минимальный разбор каталога gettext — ровно столько,
 * сколько нужно проверке полноты русского перевода: контекст, исходная
 * строка, перевод и ссылка на место в коде.
 *
 * Своя реализация, а не зависимость: в рантайме сервера эти файлы не читаются
 * (ядро работает со скомпилированным `locales/generated/*.ts`), и тащить
 * парсер po в зависимости продакшен-пакета ради одной проверки незачем.
 */

export type PoEntry = {
  context: string | null;
  msgId: string;
  msgStr: string;
  reference: string | null;
};

const unquote = (line: string): string => {
  const match = line.match(/"((?:[^"\\]|\\.)*)"/);

  if (match === null) {
    return '';
  }

  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
};

export const parsePoCatalog = (content: string): PoEntry[] => {
  const entries: PoEntry[] = [];

  let context: string | null = null;
  let msgId: string | null = null;
  let msgStr: string | null = null;
  let reference: string | null = null;
  let mode: 'context' | 'msgId' | 'msgStr' | null = null;

  const flush = (): void => {
    // Первая запись каталога — служебная шапка с пустым msgid.
    if (msgId !== null && msgId !== '') {
      entries.push({ context, msgId, msgStr: msgStr ?? '', reference });
    }
    context = null;
    msgId = null;
    msgStr = null;
    reference = null;
    mode = null;
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      flush();
      continue;
    }

    if (line.startsWith('#:')) {
      reference = reference ?? line.slice(2).trim();
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('msgctxt ')) {
      context = unquote(line);
      mode = 'context';
      continue;
    }

    if (line.startsWith('msgid_plural ')) {
      mode = null;
      continue;
    }

    if (line.startsWith('msgid ')) {
      msgId = unquote(line);
      mode = 'msgId';
      continue;
    }

    if (line.startsWith('msgstr[')) {
      // Формы множественного числа: для проверки достаточно знать, что
      // перевод вообще есть, поэтому склеиваем их в одну строку.
      msgStr = (msgStr ?? '') + unquote(line);
      mode = null;
      continue;
    }

    if (line.startsWith('msgstr ')) {
      msgStr = unquote(line);
      mode = 'msgStr';
      continue;
    }

    if (line.startsWith('"') && mode !== null) {
      const value = unquote(line);

      if (mode === 'context') context = (context ?? '') + value;
      if (mode === 'msgId') msgId = (msgId ?? '') + value;
      if (mode === 'msgStr') msgStr = (msgStr ?? '') + value;
    }
  }

  flush();

  return entries;
};
