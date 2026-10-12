/**
 * ONE-107 (Onema). Что разрешено оставить латиницей в русском каталоге.
 *
 * Требование владельца Onema 2026-10-12: «абсолютно все тексты, анимации и
 * т. д. должны быть на русском». Исключения — только то, у чего русского
 * написания нет: бренды, коды, примеры значений и строки из одних подстановок.
 *
 * Списки закрытые: проверка `__tests__/ru-locale.spec.ts` падает на всём,
 * чего здесь нет. Пополнять их — осознанное решение, видимое в ревью.
 */

/**
 * Исходные строки, у которых перевод законно пуст или совпадает с
 * оригиналом. Пустой перевод означает «показывай как есть», и для кода или
 * псевдонима команды это правильное поведение.
 */
export const RU_LOCALE_UNTRANSLATED_BY_DESIGN: ReadonlySet<string> = new Set([
  // Псевдонимы команд текстового редактора: пользователь набирает их сам.
  'cta',
  'h1',
  'h2',
  'h3',
  'hr',
  'html',
  'ol',
  'ordered',
  'p',
  'ul',
  // Коды и сокращения.
  'API',
  'CRUD',
  'GraphQL',
  'HTML',
  'HTTP',
  'ID',
  'iFrame',
  'In-Reply-To',
  'JSON',
  'MCP',
  'OAuth',
  'OAuth 2.0',
  'PDF',
  'REST',
  'SDK',
  'SSO (SAML / OIDC)',
  'URI',
  // Бренды и названия продуктов.
  'Amazon Q Developer CLI',
  'Apple',
  'apple',
  'Augment Code',
  'ChatGPT',
  'Claude',
  'Cline',
  'Cursor',
  'Gemini CLI',
  'Google',
  'Google OIDC',
  'Goose',
  'JetBrains AI / Junie',
  'LibreChat',
  'LM Studio',
  'Microsoft',
  'Raycast',
  'Replit Agent',
  'VS Code',
  'Warp',
  'Windsurf / Cascade',
  'Zed',
  // Примеры значений: пользователь вводит ровно такую форму.
  'AKIA...',
  'caldav.example.com',
  'customer_satisfaction',
  'eddy@gmail.com, @apple.com',
  'https://api.example.com/endpoint',
  'https://api.example.com/v1',
  'https://example.com/callback',
  'https://example.com/embed',
  'https://example.com/webhook',
  'imap.example.com',
  'john.doe',
  'john.doe@example.com',
  'mySkill',
  'profession',
  'recipient@example.com',
  'sk-...',
  'smtp.example.com',
  'us-east-1',
  'would_recommend',
]);

/**
 * Латинские слова, которые разрешено оставить внутри русской подписи объекта
 * или поля. Это то, что владелец видит в каждой таблице и карточке, поэтому
 * список особенно короткий.
 */
export const RU_LOCALE_ALLOWED_LATIN_WORDS: readonly string[] = [
  'ID',
  'URL',
  'UID',
  'iCal',
  'LinkedIn',
];

/** Контексты, подписи в которых пользователь видит постоянно. */
export const RU_LOCALE_METADATA_CONTEXTS: readonly string[] = [
  'objectMetadata.labelSingular',
  'objectMetadata.labelPlural',
  'fieldMetadata.label',
];
