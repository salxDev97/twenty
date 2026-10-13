import { readFileSync } from 'fs';
import { resolve } from 'path';

// Правило запрещает считать идентификатор сообщения руками, чтобы резолверы
// метаданных не разъехались между собой: их дело — звать
// resolveEffectiveEntityProperty. Здесь не резолвер, а проверка самого
// каталога: она сверяет, что скомпилированный `generated/ru-RU.ts` отвечает
// тем же ключам, по которым его спросит ядро. Своя копия хеширования сделала
// бы проверку бессмысленной — она обязана считать ровно то же, что и ядро,
// поэтому берётся та же функция.
// eslint-disable-next-line no-restricted-imports
import { generateMessageId } from 'twenty-shared/i18n';

import {
  parsePoCatalog,
  type PoEntry,
} from 'src/engine/core-modules/i18n/onema/parse-po-catalog.util';
import {
  RU_LOCALE_ALLOWED_LATIN_WORDS,
  RU_LOCALE_METADATA_CONTEXTS,
  RU_LOCALE_UNTRANSLATED_BY_DESIGN,
} from 'src/engine/core-modules/i18n/onema/ru-locale-exceptions.constant';

/**
 * ONE-107 (Onema). Русский каталог ядра должен покрывать интерфейс целиком —
 * см. `../README.md`. Проверка читает сами каталоги, сервер при этом не
 * поднимается.
 */

const PACKAGES_DIR = resolve(__dirname, '../../../../../../..');

const CATALOGS = [
  {
    name: 'twenty-server',
    po: `${PACKAGES_DIR}/twenty-server/src/engine/core-modules/i18n/locales/ru-RU.po`,
    compiled: `${PACKAGES_DIR}/twenty-server/src/engine/core-modules/i18n/locales/generated/ru-RU.ts`,
  },
  {
    name: 'twenty-front',
    po: `${PACKAGES_DIR}/twenty-front/src/locales/ru-RU.po`,
    compiled: `${PACKAGES_DIR}/twenty-front/src/locales/generated/ru-RU.ts`,
  },
  {
    name: 'twenty-emails',
    po: `${PACKAGES_DIR}/twenty-emails/src/locales/ru-RU.po`,
    compiled: `${PACKAGES_DIR}/twenty-emails/src/locales/generated/ru-RU.ts`,
  },
];

const readCatalog = (path: string): PoEntry[] =>
  parsePoCatalog(readFileSync(path, 'utf8'));

const readCompiledMessages = (path: string): Record<string, unknown> => {
  const source = readFileSync(path, 'utf8');
  const openQuote = source.indexOf('"', source.indexOf('JSON.parse('));
  const closeQuote = source.lastIndexOf('"');
  // lingui печатает неразрывный пробел как `\xA0` — в JSON такого
  // экранирования нет, поэтому переводим его в форму \u00A0.
  const literal = source
    .slice(openQuote, closeQuote + 1)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => `\\u00${hex}`);

  return JSON.parse(JSON.parse(literal) as string) as Record<string, unknown>;
};

const hasLatin = (value: string): boolean => /[A-Za-z]/.test(value);

/**
 * Ключ строки в скомпилированном каталоге. У каталогов сервера и фронта это
 * хеш от пары «строка + контекст» (его же считает ядро в
 * `translateStandardLabel`), а каталог писем собран с
 * `js-lingui-explicit-id` — там ключ и есть сама строка.
 */
const findCompiledValue = (
  messages: Record<string, unknown>,
  entry: PoEntry,
): unknown =>
  messages[generateMessageId(entry.msgId, entry.context ?? '')] ??
  messages[entry.msgId];

const describeEntry = (entry: PoEntry): string =>
  `[${entry.context ?? 'без контекста'}] «${entry.msgId}» → «${entry.msgStr}» (${entry.reference ?? 'без ссылки'})`;

describe.each(CATALOGS)(
  'ONE-107: русский каталог $name',
  ({ po, compiled }) => {
    const entries = readCatalog(po);

    it('каталог прочитан и не пуст', () => {
      expect(entries.length).toBeGreaterThan(50);
    });

    it('нет пустых переводов, кроме кодов и псевдонимов из списка исключений', () => {
      const empty = entries
        .filter((entry) => entry.msgStr === '')
        .filter((entry) => !RU_LOCALE_UNTRANSLATED_BY_DESIGN.has(entry.msgId))
        .map(describeEntry);

      expect(empty).toEqual([]);
    });

    it('перевод не повторяет английский исходник, кроме брендов, кодов и примеров', () => {
      const untranslated = entries
        .filter((entry) => entry.msgStr !== '' && entry.msgStr === entry.msgId)
        .filter((entry) => hasLatin(entry.msgStr))
        // Строка из одних подстановок переводить нечего: `{a} {b}` и так
        // одинаков на всех языках.
        .filter((entry) => hasLatin(entry.msgStr.replace(/\{[^}]*\}/g, ' ')))
        .filter((entry) => !RU_LOCALE_UNTRANSLATED_BY_DESIGN.has(entry.msgId))
        .map(describeEntry);

      expect(untranslated).toEqual([]);
    });

    it('в подписях объектов и полей нет латиницы, кроме списка слов-исключений', () => {
      const allowed = new Set(
        RU_LOCALE_ALLOWED_LATIN_WORDS.map((word) => word.toLowerCase()),
      );

      const offenders = entries
        .filter(
          (entry) =>
            entry.context !== null &&
            RU_LOCALE_METADATA_CONTEXTS.includes(entry.context),
        )
        .map((entry) => ({
          entry,
          words: (entry.msgStr.match(/[A-Za-z]+/g) ?? []).filter(
            (word) => !allowed.has(word.toLowerCase()),
          ),
        }))
        .filter(({ words }) => words.length > 0)
        .map(
          ({ entry, words }) =>
            `${describeEntry(entry)} — латиница: ${words.join(', ')}`,
        );

      expect(offenders).toEqual([]);
    });

    it('скомпилированный каталог содержит каждый перевод из .po', () => {
      const messages = readCompiledMessages(compiled);
      const missing = entries
        .filter((entry) => entry.msgStr !== '')
        .filter((entry) => findCompiledValue(messages, entry) === undefined)
        .map(describeEntry);

      expect(missing).toEqual([]);
    });

    it('простые переводы в скомпилированном каталоге совпадают с .po', () => {
      const messages = readCompiledMessages(compiled);
      const stale = entries
        // Только строки без ICU и без экранирования кавычкой: у них
        // скомпилированная форма — ровно `[перевод]`, и расхождение означает
        // «перевели в .po, но не пересобрали каталог».
        .filter((entry) => entry.msgStr !== '' && !/[{#']/.test(entry.msgStr))
        .filter(
          (entry) =>
            JSON.stringify(findCompiledValue(messages, entry)) !==
            JSON.stringify([entry.msgStr]),
        )
        .map(describeEntry);

      expect(stale).toEqual([]);
    });
  },
);
