import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  artifactExcerpt,
  artifactExt,
  artifactHtml,
  htmlText,
  readArtifact,
  writeArtifact,
} from './artifact';
import { docExcerpt, docKind } from './summary';

describe('артефакты (решение 0023)', () => {
  it('запись, перезапись и чтение', () => {
    const doc = new Y.Doc();
    expect(readArtifact(doc)).toBeNull();
    writeArtifact(doc, {
      kind: 'html',
      source: '<h1>Калькулятор</h1><script>x()</script><p>Сумма &amp; итог</p>',
    });
    writeArtifact(doc, { kind: 'html', source: '<h1>Калькулятор 2</h1><p>Сумма &amp; итог</p>' });
    expect(readArtifact(doc)?.source).toContain('Калькулятор 2');
    expect(docKind('ar_x')).toBe('artifact');
    expect(docExcerpt('ar_x', doc)).toBe('HTML-страница\nКалькулятор 2\nСумма & итог');
  });

  it('видимый текст HTML и страницы для просмотра', () => {
    expect(htmlText('<style>a{}</style><div>Раз</div><div>Два</div>')).toBe('Раз\nДва');
    expect(artifactExcerpt({ kind: 'code', lang: 'python', source: 'print(1)' })).toBe(
      'Код · python\nprint(1)',
    );
    expect(artifactHtml({ kind: 'html', source: '<p>x</p>' })).toContain('<body><p>x</p></body>');
    expect(artifactHtml({ kind: 'mermaid', source: 'graph TD; A-->B' })).toContain('mermaid');
    expect(artifactHtml({ kind: 'code', source: '<b>' })).toContain('&lt;b&gt;');
  });
});

describe('расширение исходника', () => {
  it('по виду и языку', () => {
    expect(artifactExt({ kind: 'html' })).toBe('html');
    expect(artifactExt({ kind: 'code', lang: 'TypeScript' })).toBe('ts');
    expect(artifactExt({ kind: 'code', lang: 'go' })).toBe('go');
    expect(artifactExt({ kind: 'code', lang: 'что-то странное' })).toBe('txt');
    expect(artifactExt({ kind: 'mermaid' })).toBe('mmd');
  });
});
