/**
 * Sunra internationalisation support.
 *
 * i18n is intentionally data-first: the compiler can extract a deterministic
 * string table without needing a filesystem or a browser, while the runtime can
 * switch locale atomically and fall back to the source text. Both `@locale("th")`
 * and the attribute spelling `#[locale("th")]` are accepted so source written
 * against either form remains portable.
 */

export interface I18nMessage {
  key: string;
  source: string;
  /** Source line (1-based), useful for editor diagnostics and review tooling. */
  line: number;
  /** Locale active at the point where the literal was found. */
  locale: string;
  /** Optional explicit message id from @message/@text. */
  explicit: boolean;
}

export interface LocaleTable {
  locale: string;
  messages: Record<string, string>;
}

export interface StringTable {
  defaultLocale: string;
  locales: string[];
  messages: I18nMessage[];
  tables: Record<string, Record<string, string>>;
}

export interface LocaleAnnotation {
  locale: string;
  line: number;
  column: number;
}

const DEFAULT_LOCALE = "en";
const LOCALE_RE = /(?:@|#\[)locale\s*\(\s*["']([^"']+)["']\s*\)?\]?/g;
const EXPLICIT_RE = /(?:@|#\[)(?:message|text)\s*\(\s*["']([^"']+)["']\s*(?:,\s*(["'][^\n]*?["']))?\s*\)?\]?/g;
const STRING_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const LOCALE_DECL_RE = /(?:^|\n)\s*(?:locale|language)\s*=\s*["']([^"']+)["']/;

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function columnAt(source: string, offset: number): number {
  const last = source.lastIndexOf("\n", offset - 1);
  return offset - (last < 0 ? 0 : last + 1) + 1;
}

function unquote(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/\\'/g, "'") : value;
}

function canonicalLocale(locale: string): string {
  const clean = locale.trim().replace(/_/g, "-");
  if (!clean) return DEFAULT_LOCALE;
  const parts = clean.split("-");
  return [parts[0].toLowerCase(), ...parts.slice(1).map((p) => p.toUpperCase())].join("-");
}

/** Parse locale directives without depending on the parser's attribute grammar. */
export function extractLocaleAnnotations(source: string): LocaleAnnotation[] {
  const annotations: LocaleAnnotation[] = [];
  for (const match of source.matchAll(LOCALE_RE)) {
    const offset = match.index ?? 0;
    annotations.push({ locale: canonicalLocale(match[1]), line: lineAt(source, offset), column: columnAt(source, offset) });
  }
  const declaration = LOCALE_DECL_RE.exec(source);
  if (declaration) {
    const offset = declaration.index;
    annotations.unshift({ locale: canonicalLocale(declaration[1]), line: lineAt(source, offset), column: columnAt(source, offset) });
  }
  return annotations.sort((a, b) => a.line - b.line || a.column - b.column);
}

function localeAt(source: string, offset: number, initial: string): string {
  let locale = canonicalLocale(initial);
  const before = source.slice(0, offset);
  for (const match of before.matchAll(LOCALE_RE)) locale = canonicalLocale(match[1]);
  const declaration = LOCALE_DECL_RE.exec(before);
  if (declaration) locale = canonicalLocale(declaration[1]);
  return locale;
}

/** Extract all source strings and explicit messages into a stable, JSON-ready table. */
export function extractStringTable(source: string, defaultLocale = DEFAULT_LOCALE): StringTable {
  const initial = canonicalLocale(defaultLocale);
  const messages: I18nMessage[] = [];
  const ignoredStringRanges: Array<[number, number]> = [];
  for (const match of source.matchAll(LOCALE_RE)) {
    const offset = match.index ?? 0;
    ignoredStringRanges.push([offset, offset + match[0].length]);
  }

  for (const match of source.matchAll(EXPLICIT_RE)) {
    const offset = match.index ?? 0;
    const key = unquote(match[1]);
    const value = match[2] ? unquote(match[2]) : key;
    const locale = localeAt(source, offset, initial);
    messages.push({ key, source: value, line: lineAt(source, offset), locale, explicit: true });
    ignoredStringRanges.push([offset, offset + match[0].length]);
  }

  for (const match of source.matchAll(STRING_RE)) {
    const offset = match.index ?? 0;
    // Annotation/directive arguments are metadata, not translatable messages.
    if (ignoredStringRanges.some(([start, end]) => offset >= start && offset < end)) continue;
    const value = unquote(match[0]);
    if (value.length === 0) continue;
    const locale = localeAt(source, offset, initial);
    messages.push({ key: value, source: value, line: lineAt(source, offset), locale, explicit: false });
  }

  messages.sort((a, b) => a.line - b.line || a.key.localeCompare(b.key));
  const tables: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    const table = (tables[message.locale] ??= {});
    if (!(message.key in table) || message.explicit) table[message.key] = message.source;
  }
  const locales = Object.keys(tables).sort((a, b) => a.localeCompare(b));
  if (!locales.includes(initial)) locales.unshift(initial);
  return { defaultLocale: initial, locales, messages, tables };
}

export function stringTableJson(source: string, defaultLocale = DEFAULT_LOCALE): string {
  return JSON.stringify(extractStringTable(source, defaultLocale), null, 2) + "\n";
}

export function mergeLocaleTables(...tables: LocaleTable[]): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {};
  for (const table of tables) merged[canonicalLocale(table.locale)] = { ...(merged[canonicalLocale(table.locale)] ?? {}), ...table.messages };
  return merged;
}

/** Runtime lookup with locale fallback: exact locale, language, default, key. */
export class LocaleRuntime {
  private currentLocale: string;
  private readonly defaultLocale: string;
  private readonly tables: Record<string, Record<string, string>>;

  constructor(defaultLocale = DEFAULT_LOCALE, tables: Record<string, Record<string, string>> = {}) {
    this.defaultLocale = canonicalLocale(defaultLocale);
    this.currentLocale = this.defaultLocale;
    this.tables = {};
    for (const [locale, messages] of Object.entries(tables)) this.tables[canonicalLocale(locale)] = { ...messages };
  }

  get locale(): string { return this.currentLocale; }
  get locales(): string[] { return Object.keys(this.tables).sort(); }

  setLocale(locale: string): string {
    const requested = canonicalLocale(locale);
    const language = requested.split("-")[0];
    const available = this.locales;
    const selected = available.includes(requested) ? requested : available.find((item) => item.split("-")[0] === language);
    this.currentLocale = selected ?? requested;
    return this.currentLocale;
  }

  add(locale: string, messages: Record<string, string>): void {
    const key = canonicalLocale(locale);
    this.tables[key] = { ...(this.tables[key] ?? {}), ...messages };
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  translate(key: string, fallback = key): string {
    return this.lookup(key) ?? fallback;
  }

  format(key: string, vars: Record<string, string | number | boolean> = {}, fallback = key): string {
    return this.translate(key, fallback).replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
    );
  }

  snapshot(): { locale: string; defaultLocale: string; tables: Record<string, Record<string, string>> } {
    return { locale: this.currentLocale, defaultLocale: this.defaultLocale, tables: JSON.parse(JSON.stringify(this.tables)) as Record<string, Record<string, string>> };
  }

  private lookup(key: string): string | undefined {
    const exact = this.tables[this.currentLocale]?.[key];
    if (exact !== undefined) return exact;
    const language = this.currentLocale.split("-")[0];
    const regional = Object.entries(this.tables).find(([locale]) => locale.split("-")[0] === language)?.[1]?.[key];
    if (regional !== undefined) return regional;
    return this.tables[this.defaultLocale]?.[key];
  }
}

export function localeFromEnv(env: Record<string, string | undefined> = {}): string {
  return canonicalLocale(env.SUNRA_LOCALE ?? env.LC_ALL ?? env.LANG ?? DEFAULT_LOCALE);
}

export const i18n = { canonicalLocale, extractLocaleAnnotations, extractStringTable, stringTableJson, mergeLocaleTables, LocaleRuntime, localeFromEnv };
