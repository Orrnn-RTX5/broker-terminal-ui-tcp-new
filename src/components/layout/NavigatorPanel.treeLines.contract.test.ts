import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const readSource = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

const navigatorSource = readSource('src/components/layout/NavigatorPanel.tsx');

const treeItemSource = navigatorSource.slice(
  navigatorSource.indexOf('function TreeItem('),
);

describe('Navigator tree branch lines', () => {
  it('renders every vertical and horizontal connector as a solid line', () => {
    expect(treeItemSource.match(/1px solid var\(--navigator-tree-line, #555\)/g)).toHaveLength(3);
    expect(treeItemSource).not.toMatch(/1px (?:dashed|dotted) var\(--navigator-tree-line, #555\)/);
  });

  it('extends horizontal branch lines on non-expandable leaf items to reach near the row icon', () => {
    const navigatorCss = readSource('src/components/layout/NavigatorPanel.css');
    expect(treeItemSource).toContain("navigator-tree-item__line--leaf");
    expect(treeItemSource).toContain("width: isExpandable ? '8px' : '26px'");
    expect(navigatorCss).toMatch(
      /\.navigator-panel \.navigator-tree-item__line--leaf\[style\*="top: 15px"\]\s*\{\s*width:\s*21px !important;\s*\}/,
    );
    expect(navigatorCss).toMatch(
      /html\.rtx-advanced-view\.rtx-skin-untitled-light \.navigator-panel \.navigator-tree-item__line--leaf\s*\{\s*width:\s*28px !important;\s*\}/,
    );
  });

  it('does not add vertical row margins in light theme that break sibling connector lines', () => {
    const lightSheets = [
      'src/styles/legacy-light-overrides.css',
      'src/styles/enterprise-light.css',
      'src/components/layout/NavigatorPanel.css',
    ];
    const nonZeroVerticalMargins: string[] = [];

    for (const sheetPath of lightSheets) {
      parse(readSource(sheetPath), { from: sheetPath }).walkRules((rule) => {
        if (!/\.navigator-tree-item(?:__row)?(?=$|[\s,:.[#])/.test(rule.selector)) {
          return;
        }
        rule.walkDecls(/^margin(?:-(?:top|bottom))?$/, (decl) => {
          const normalized = decl.value.replace(/\s*!important\s*$/i, '').trim();
          const parts = normalized.split(/\s+/);
          const verticalParts = decl.prop === 'margin'
            ? (parts.length <= 2 ? [parts[0]] : [parts[0], parts[2]])
            : [parts[0]];
          const isZero = verticalParts.every((part) => /^0(?:[a-z%]+)?$/i.test(part));
          if (!isZero) {
            nonZeroVerticalMargins.push(`${sheetPath}:${decl.source?.start?.line} ${rule.selector} { ${decl.prop}: ${decl.value} }`);
          }
        });
      });
    }

    expect(nonZeroVerticalMargins).toEqual([]);
    expect(readSource('src/styles/enterprise-light.css')).toMatch(
      /html\.rtx-advanced-view\.rtx-skin-untitled-light \.navigator-tree-item__row\s*\{[\s\S]*?margin-bottom: 0 !important;/,
    );
  });
});
