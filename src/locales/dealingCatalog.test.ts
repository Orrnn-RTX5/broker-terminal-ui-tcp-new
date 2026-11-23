import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { supportedLanguages } from '../config/supportedLanguages';
import { DEALING_UI_STRING_KEYS } from '../services/dealing/dealingI18n';
import englishUi from './en/ui.json';
import translationTodoData from './translation-todo.json';

const catalogs = import.meta.glob('./*/ui.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>;

const translationTodo: readonly string[] = translationTodoData.allowMissing;

const VENDOR_BRAND = /rtx[\s-]?5|आरटीएक्स|orrnn/i;

const placeholders = (value: string) =>
  [...value.matchAll(/{{\s*([^}]+)\s*}}/g)].map((match) => match[1].trim()).sort();

const ALL_DEALING_UI_KEYS = Array.from(new Set([...DEALING_UI_STRING_KEYS, 'Dismiss']));

describe('dealing UI i18n catalog coverage', () => {
  it('registers every dealing UI key and Dismiss in en/ui.json with neutral values and intact placeholders', () => {
    const ui = englishUi as Record<string, unknown>;
    for (const key of ALL_DEALING_UI_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(ui, key), `en/ui missing: ${key}`).toBe(true);
      const value = ui[key];
      expect(typeof value, `en/ui type: ${key}`).toBe('string');
      const text = value as string;
      expect(text.trim(), `en/ui non-empty: ${key}`).not.toBe('');
      expect(text, `en/ui single line: ${key}`).not.toContain('\n');
      expect(placeholders(text), `en/ui placeholders: ${key}`).toEqual(placeholders(key));
      expect(VENDOR_BRAND.test(text), `en/ui brand-neutral: ${key}`).toBe(false);
    }
  });

  it('covers every literal tr/translateUi/feedbackLabel call under src/components/dealing and src/services/dealing', () => {
    const ui = englishUi as Record<string, unknown>;
    const missing: string[] = [];
    const scanDirs = [
      resolve(process.cwd(), 'src/components/dealing'),
      resolve(process.cwd(), 'src/services/dealing'),
    ];

    const inspect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          inspect(fullPath);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name) || /\.bench\./.test(entry.name)) {
          continue;
        }
        const sourceText = readFileSync(fullPath, 'utf8');
        const source = ts.createSourceFile(fullPath, sourceText, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && ['tr', 'translateUi', 'feedbackLabel'].includes(node.expression.text)
          ) {
            const arg = node.arguments[0];
            if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
              const key = arg.text.trim();
              if (key && !Object.prototype.hasOwnProperty.call(ui, key)) {
                missing.push(`${entry.name}: ${key}`);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    };

    for (const dir of scanDirs) {
      inspect(dir);
    }
    expect(missing).toEqual([]);
  });

  it.each(supportedLanguages.filter(({ code }) => code !== 'en'))(
    '$code either translates every dealing UI key cleanly or allows English fallback via translation-todo.json',
    ({ code }) => {
      const resource = catalogs[`./${code}/ui.json`];
      expect(resource, `${code}/ui exists`).toBeDefined();
      const english = englishUi as Record<string, string>;

      for (const key of ALL_DEALING_UI_KEYS) {
        const label = `${code}/ui: ${key}`;
        const translated = resource[key];
        if (translated === undefined) {
          expect(translationTodo.includes(key), `${label} missing without allowMissing`).toBe(true);
          continue;
        }
        expect(typeof translated, label).toBe('string');
        const text = translated as string;
        expect(text.trim(), label).not.toBe('');
        expect(text, label).not.toContain('\n');
        expect(placeholders(text), label).toEqual(placeholders(english[key]));
        expect(VENDOR_BRAND.test(text), label).toBe(false);
      }
    },
  );
});
