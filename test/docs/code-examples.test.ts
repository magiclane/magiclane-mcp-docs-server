/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { extractCodeBlocks, filterByLanguage, splitLongBlocks } from '../../src/docs/code-examples.js';
import { scanMarkdown, stripAnchorArtifacts } from '../../src/docs/markdown.js';

const PAGE = `# Add Markers

Intro prose.

## Setup[\u200b](#setup "Direct link to Setup")

\`\`\`dart
final marker = Marker();
\`\`\`

Some text.

\`\`\`
plain text block
\`\`\`

\`\`\`json
\`\`\`

### Shell

\`\`\`bash
# install the sdk
flutter pub add gem_kit
\`\`\`

\`\`\`Kotlin
val x = 1
\`\`\`
`;

describe('splitLongBlocks', () => {
  it('passes short blocks through as a single part', () => {
    expect(splitLongBlocks([{ language: 'js', code: 'a();' }], 10)).toEqual([
      { language: 'js', code: 'a();', block: 0, part: 1, parts: 1, midLine: false },
    ]);
  });

  it('cuts at line breaks, and a line longer than a part without splitting a surrogate pair', () => {
    const parts = splitLongBlocks([{ language: 'js', code: 'aaaa\n bbbb', heading: 'H' }], 9);
    expect(parts.map((p) => p.code)).toEqual(['aaaa', ' bbbb']);
    expect(parts.every((p) => p.heading === 'H' && p.parts === 2)).toBe(true);
    const long = splitLongBlocks([{ language: 'txt', code: 'x\n' + 'abc\u{1F600}def' }], 4);
    expect(long.map((p) => p.code)).toEqual(['x', 'abc', '\u{1F600}de', 'f']);
    const exact = splitLongBlocks([{ language: 'txt', code: 'abcdefgh\nij' }], 4);
    expect(exact.map((p) => p.code)).toEqual(['abcd', 'efgh', 'ij']);
    const multiple = splitLongBlocks([{ language: 'txt', code: 'abcdefgh' }], 4);
    expect(multiple.map((p) => [p.code, p.midLine])).toEqual([
      ['abcd', true],
      ['efgh', false],
    ]);
    expect(long.map((p) => p.midLine)).toEqual([false, true, true, false]);
  });

  it('keeps blank lines at part boundaries, so the parts joined with newlines are the block', () => {
    for (const code of [
      'a\n\nb',
      'aaaa\n\n\nbbbb',
      'x\n\n',
      'abcd\n',
      'line1\nline2\n\nline3\nline4',
      'ab\n\ncd\n\nef',
    ]) {
      for (const size of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const parts = splitLongBlocks([{ language: 'txt', code }], size);
        // Pieces that end mid-line are continued without a newline.
        const joined = parts.reduce((acc, p, i) => acc + (i > 0 && !parts[i - 1]!.midLine ? '\n' : '') + p.code, '');
        expect(joined, `${JSON.stringify(code)} @ ${size}`).toBe(code);
        for (const p of parts) expect(p.code.length, `${JSON.stringify(code)} @ ${size}`).toBeLessThanOrEqual(size);
      }
    }
  });
});

describe('extractCodeBlocks: tab groups', () => {
  it('labels each block of a Docusaurus tab group with its own tab, not the last label above them', () => {
    const page =
      'Monitor an area:\n\n* Kotlin\n* Java\n\n```kotlin\nval a = 1\n```\n\n```java\nint a = 1;\n```\n\n' +
      'Then:\n\n```kotlin\nval b = 2\n```\n';
    expect(extractCodeBlocks(page).map((b) => `${b.language}:${b.caption}`)).toEqual([
      'kotlin:Kotlin',
      'java:Java',
      'kotlin:Then',
    ]);
    // A single list item above a fence is still its caption; prose ends a group.
    expect(extractCodeBlocks('* Request Body\n\n```json\n{}\n```\n')[0]!.caption).toBe('Request Body');
    // The last item of a page's own list is not: a list item captions a block only when it stands alone.
    const prose =
      '- The operation error code is returned.\n- A list of the items found, when any.\n\n```kotlin\nval c = 3\n```\n';
    expect(extractCodeBlocks(prose)[0]!.caption).toBeUndefined();
    // …and a tab group right below such a list is still read as one.
    const listed = `${prose.split('\n\n')[0]}\n\n- Kotlin\n- Java\n\n\`\`\`kotlin\nval k = 1\n\`\`\`\n\n\`\`\`java\nint j = 1;\n\`\`\`\n`;
    expect(extractCodeBlocks(listed).map((b) => b.caption)).toEqual(['Kotlin', 'Java']);
    expect(
      extractCodeBlocks('* UIKit\n* SwiftUI\n\nProse about both.\n\n```swift\nlet a = 1\n```\n')[0]!.caption
    ).toBeUndefined();
  });

  it('keeps a list item written as a label as the caption, even after other list items', () => {
    // The Geofences API shape: the labelled request body after the endpoint and headers items.
    const geofences =
      '* **Endpoint:** `POST /add_geofence_area`\n\n* **Headers:**\n\n  * `Authorization: YOUR_API_KEY`\n' +
      '  * `Accept: application/json`\n\n* **Request Body:**\n\n```json\n{"geofences": []}\n```\n\n' +
      '* **Endpoint:** `GET /get_geofence_areas`\n\n* **Request Body**:\n\n```json\n{"p_ids": []}\n```\n';
    expect(extractCodeBlocks(geofences).map((b) => b.caption)).toEqual(['Request Body', 'Request Body']);
    // A label may carry a remark in parentheses ("* **Response Body:** (code `200 OK`)" after the parameters).
    const remark =
      '* **Parameters:**\n\n  * `p_location` - coordinates\n  * `p_limit_count` - how many\n\n' +
      '* **Response Body:** (code `200 OK`)\n\n```json\n[]\n```\n\n' +
      '* `p_location` - coordinates\n* `p_limit_count` - how many (see the `limit` parameter)\n\n```json\n{}\n```\n';
    expect(extractCodeBlocks(remark).map((b) => b.caption)).toEqual(['Response Body (code 200 OK)', undefined]);
    // A numbered step ending in a colon labels its block; a prose step after another is no caption.
    const steps =
      '1. Open the `src/token.js` file\n2. Replace the token placeholder with your actual token:\n\n' +
      '```javascript\nexport const TOKEN = "";\n```\n\n' +
      '3. Copy the response.\n4. Modify the desired fields, such as the name.\n\n```json\n{}\n```\n';
    expect(extractCodeBlocks(steps).map((b) => b.caption)).toEqual([
      'Replace the token placeholder with your actual token',
      undefined,
    ]);
    // So does a nested step under a numbered one.
    const nested = '4. The app will:\n\n   * Make an HTTP request to:\n\n   ```http\n   GET /services\n   ```\n';
    expect(extractCodeBlocks(nested)[0]!.caption).toBe('Make an HTTP request to');
  });
});

describe('extractCodeBlocks', () => {
  const blocks = extractCodeBlocks(PAGE);

  it('extracts every non-empty fenced block with its lower-cased language', () => {
    expect(blocks.map((b) => b.language)).toEqual(['dart', 'text', 'bash', 'kotlin']);
  });

  it('keeps the code content without fence markers and trailing whitespace', () => {
    expect(blocks[0]!.code).toBe('final marker = Marker();');
    expect(blocks[2]!.code).toBe('# install the sdk\nflutter pub add gem_kit');
  });

  it('attaches the nearest heading above each block, without anchor artifacts', () => {
    expect(blocks[0]!.heading).toBe('Setup');
    expect(blocks[1]!.heading).toBe('Setup');
  });

  it('does not take a # comment inside a block for a heading', () => {
    expect(blocks[3]!.heading).toBe('Shell');
  });

  it('skips empty blocks and returns nothing for pages without code', () => {
    expect(blocks.some((b) => b.language === 'json')).toBe(false);
    expect(extractCodeBlocks('No code here.')).toEqual([]);
  });

  it('takes a label line above the fence as the caption, cleaned of markdown, but never prose or a link', () => {
    const page =
      '* **Request Body:**\n\n```json\n1\n```\n\nPlain prose.\n\n```json\n2\n```\n\n' +
      '1. **Create Configuration**: set the `name`.\n\n```json\n3\n```\n\n[View on Github](https://x)\n\n```json\n4\n```\n\n' +
      'Then run:\n\n```sh\n5\n```\n\n| a | b |\n\n```json\n6\n```\n';
    expect(extractCodeBlocks(page).map((b) => b.caption)).toEqual([
      'Request Body',
      undefined,
      'Create Configuration: set the name.',
      undefined,
      'Then run',
      undefined,
    ]);
    // A label of nothing but markers, or longer than a label gets, is not one.
    expect(extractCodeBlocks('**:**\n\n```js\n1\n```')[0]!.caption).toBeUndefined();
    expect(extractCodeBlocks(`**${'x'.repeat(121)}:**\n\n\`\`\`js\n1\n\`\`\``)[0]!.caption).toBeUndefined();
    // The length is the line's as the page wrote it: a link to one of the site's
    // pages counts by its path, so a label stays one after its links are
    // rewritten as web pages; any other link counts in full.
    const linked =
      'The code is identical to the full SDK — see the ' +
      '[Get started guide](https://developer.magiclane.com/docs/typescript/guides/get-started)';
    expect(linked.length).toBeGreaterThan(120);
    expect(extractCodeBlocks(`${linked}:\n\n\`\`\`ts\n1\n\`\`\``)[0]!.caption).toBe(linked);
    const external = `${'x'.repeat(100)} [WGS](https://en.wikipedia.org/wiki/World_Geodetic_System):`;
    expect(extractCodeBlocks(`${external}\n\n\`\`\`js\n1\n\`\`\``)[0]!.caption).toBeUndefined();
  });

  it('qualifies a generic heading such as "Example" with the heading above it', () => {
    const page =
      '## Step 5: Create the Optimization\n\n#### Example:\n\n```json\n1\n```\n\n## Delete\n\n```json\n2\n```\n';
    expect(extractCodeBlocks(page).map((b) => b.heading)).toEqual([
      'Step 5: Create the Optimization › Example',
      'Delete',
    ]);
    expect(extractCodeBlocks('#### Example\n\n```json\n1\n```')[0]!.heading).toBe('Example');
  });

  it('leaves heading undefined when no heading precedes the block', () => {
    expect(extractCodeBlocks('```js\nx\n```')[0]!.heading).toBeUndefined();
  });

  it('removes the indentation of fences nested in list items', () => {
    const md = '1. Step\n\n   ```yml\n   key: value\n     nested: 1\n   ```\n';
    const [block] = extractCodeBlocks(md);
    expect(block!.language).toBe('yml');
    expect(block!.code).toBe('key: value\n  nested: 1');
  });

  it('supports ~~~ fences, longer fences, and info strings with extra words', () => {
    const md = '~~~~ts title="a.ts"\nconst a = 1;\n```\nstill inside\n~~~~\n';
    const [block] = extractCodeBlocks(md);
    expect(block!.language).toBe('ts');
    expect(block!.code).toBe('const a = 1;\n```\nstill inside');
  });

  it('keeps an unterminated fence rather than dropping it', () => {
    expect(extractCodeBlocks('```sh\necho hi\n')[0]!.code).toBe('echo hi');
    expect(extractCodeBlocks('```sh\n\n')).toEqual([]);
  });
});

describe('filterByLanguage', () => {
  const blocks = extractCodeBlocks(PAGE);

  it('returns all blocks when no language is given', () => {
    expect(filterByLanguage(blocks)).toHaveLength(4);
    expect(filterByLanguage(blocks, '  ')).toHaveLength(4);
  });

  it('filters case-insensitively and honours aliases in both the query and the fence tag', () => {
    expect(filterByLanguage(blocks, 'KOTLIN')).toHaveLength(1);
    expect(filterByLanguage(blocks, 'kt')).toHaveLength(1);
    expect(filterByLanguage(blocks, 'sh')).toHaveLength(1);
    expect(filterByLanguage(extractCodeBlocks('```yml\na: 1\n```'), 'yaml')).toHaveLength(1);
    expect(filterByLanguage(extractCodeBlocks('```c++\nint a;\n```'), 'cpp')).toHaveLength(1);
  });

  it('returns nothing for languages that are not present', () => {
    expect(filterByLanguage(blocks, 'swift')).toEqual([]);
  });
});

describe('markdown utilities', () => {
  it('strips heading anchor artifacts with or without the zero-width space', () => {
    expect(stripAnchorArtifacts('H[\u200b](#h "Direct link to H") x [](#y) [real](#z)')).toBe('H x  [real](#z)');
    // A title with parentheses leaves no '")' behind.
    expect(stripAnchorArtifacts('BLE server (BLEServer)[\u200b](#ble "Direct link to BLE server (BLEServer)")')).toBe(
      'BLE server (BLEServer)'
    );
    expect(stripAnchorArtifacts('Are "lost"[\u200b](#lost "Direct link to Are \\"lost\\" (here)")!')).toBe(
      'Are "lost"!'
    );
  });

  it('closes a fence only on the same character at least as long with nothing after it', () => {
    const lines = scanMarkdown('````\n```\n```` trailing\n````\nafter');
    expect(lines.map((l) => l.inFence)).toEqual([true, true, true, true, false]);
    expect(lines[3]!.closes).toBe(true);
  });

  it('follows CommonMark for indented code, fences indented four columns, setext and closing-# headings', () => {
    // Four columns beyond the list item (none here), after a blank line, start an indented code block, backticks
    // and all: its first line is code, and it ends at the first line indented less, which is read on.
    const indented = extractCodeBlocks(
      '# T\n\nIntro:\n\n    ```js\n    let a = 1;\n    ```\n\n## Next\n\n    let b = 2;\n\n    let c = 3;\nDone.\n'
    );
    expect(indented).toEqual([
      { language: 'text', code: '```js\nlet a = 1;\n```', heading: 'T', caption: 'Intro' },
      { language: 'text', code: 'let b = 2;\n\nlet c = 3;', heading: 'Next' },
    ]);
    // Tagged "text", as a fence that names no language is: the "text" filter finds them.
    const install = extractCodeBlocks('## Install\n\nRun this:\n\n    npm install foo\n    npm run build\n');
    expect(filterByLanguage(install, 'text')).toEqual([
      { language: 'text', code: 'npm install foo\nnpm run build', heading: 'Install', caption: 'Run this' },
    ]);
    // A tab is four columns; a line so indented right after a paragraph line continues the paragraph; a nested
    // list item four columns in is an item, not code.
    expect(extractCodeBlocks('Code:\n\n\tlet t = 1;\n')).toEqual([
      { language: 'text', code: 'let t = 1;', caption: 'Code' },
    ]);
    expect(extractCodeBlocks('Text\n    more text\n\n* item\n\n    * nested\n\n```js\nx\n```')).toEqual([
      expect.objectContaining({ language: 'js', code: 'x' }),
    ]);
    // Lists end at a sibling or outer item, and a line indented less continues an item's paragraph lazily: the
    // fence four columns in is still inside the item, and a fence.
    expect(extractCodeBlocks('1. Step\n   * sub\n2. Next\n\n    ```js\n    deep\n    ```\n')).toEqual([
      expect.objectContaining({ language: 'js', code: 'deep' }),
    ]);
    expect(extractCodeBlocks('- item\nlazy\n    ```js\n    x\n    ```\n-\n  ```kt\n  y\n  ```')).toEqual([
      expect.objectContaining({ language: 'js', code: 'x' }),
      expect.objectContaining({ language: 'kt', code: 'y' }),
    ]);
    // A tab after the marker reaches the next tab stop; five or more spaces after it leave the content one in.
    expect(extractCodeBlocks('-\titem\n\n\t    code\n')).toEqual([{ language: 'text', code: 'code', caption: 'item' }]);
    expect(extractCodeBlocks('-      x\n\n      code\n')).toEqual([{ language: 'text', code: 'code', caption: 'x' }]);
    // A closing fence indented four columns is content.
    expect(extractCodeBlocks('```js\nlet a = 1;\n    ```\nlet b = 2;\n```\n')[0]!.code).toBe(
      'let a = 1;\n    ```\nlet b = 2;'
    );
    // Setext headings head the paragraph above them (all of its lines), closing #s are dropped (a "C#" keeps
    // its own), and a heading may be indented up to three columns.
    const headings = extractCodeBlocks(
      '# T\n\nRequest\nbody\n-------\n\n```json\n{}\n```\n\n## Example ##\n\n```js\nx\n```\n\n   ### C#\n\n```cs\ny\n```\n\n' +
        'Title\n===\n\n```a\nz\n```\n'
    );
    expect(headings.map((b) => b.heading)).toEqual(['Request body', 'T › Example', 'C#', 'Title']);
    // No heading: "---" under a list item ends the list (a thematic break), "===" after a blank line is text,
    // and an ATX line of nothing but #s heads nothing.
    expect(extractCodeBlocks('- item\n---\n\n```js\nx\n```').map((b) => b.heading)).toEqual([undefined]);
    expect(extractCodeBlocks('# T\n\n===\n\n##\n\n## ##\n\n```js\nx\n```')[0]!.heading).toBe('T');
    // In a blockquote: a fence after a prose line, and inline code that is no fence.
    expect(extractCodeBlocks('> Note:\n> ```js\n> let a = 1;\n> ```\n\n> ```js` inline\n\n```dart\nb\n```')).toEqual([
      expect.objectContaining({ language: 'js', code: 'let a = 1;' }),
      expect.objectContaining({ language: 'dart', code: 'b' }),
    ]);
    // Two short list items above an indented block (inside the second item) are no tab group: the block ends at
    // the prose line after it, which is read on.
    expect(extractCodeBlocks('* Kotlin\n* Java\n\n      code\nAfter\n')).toEqual([{ language: 'text', code: 'code' }]);
  });

  it("follows CommonMark: no backtick in a backtick fence's info string, fences in blockquotes, tab indents", () => {
    // "```js` is how…" is inline code, not a fence: the real block after it is extracted alone.
    const inline = extractCodeBlocks('```js` is how a block starts\n\n```dart\nfinal a = 1;\n```');
    expect(inline).toEqual([expect.objectContaining({ language: 'dart', code: 'final a = 1;' })]);
    // A fence in a blockquote: its code without the ">" markers; leaving the quote ends it.
    const quoted = extractCodeBlocks(
      '> ```swift\n> let a = 1\n> ```\n\n> ```kotlin\n> val b = 2\n# After\n```js\nx\n```'
    );
    expect(quoted.map((b) => [b.language, b.code])).toEqual([
      ['swift', 'let a = 1'],
      ['kotlin', 'val b = 2'],
      ['js', 'x'],
    ]);
    expect(quoted[2]!.heading).toBe('After');
    // A quote that ends on a line opening a new fence: both blocks are kept.
    const next = extractCodeBlocks('> ```sh\n> ls\n```py\nprint()\n```');
    expect(next.map((b) => [b.language, b.code])).toEqual([
      ['sh', 'ls'],
      ['py', 'print()'],
    ]);
    // A tab-indented fence (a list item) loses its indent in the code.
    expect(extractCodeBlocks('-\titem\n\t```c\n\tint a;\n\t```')[0]!.code).toBe('int a;');
  });

  it('follows CommonMark: a fence in a list item ends where the item ends', () => {
    // A closer four columns beyond the item is code; the first line indented less than the item ends the item and
    // the fence with it, and is read on: the heading and the block after it are the page's own.
    expect(
      extractCodeBlocks(
        '# T\n\n- Step:\n\n  ```js\n  let a = 1;\n      ```\n\nAfter the list.\n\n## Next\n\n```js\nlet b = 2;\n```\n'
      )
    ).toEqual([
      { language: 'js', code: 'let a = 1;\n    ```', heading: 'T', caption: 'Step' },
      { language: 'js', code: 'let b = 2;', heading: 'Next' },
    ]);
    // With no closer at all: ended by the next item, by a heading (a tab-indented item), or by the outer item's
    // text (a nested item) before a new fence.
    expect(extractCodeBlocks('- One:\n\n  ```js\n  let a = 1;\n- Two:\n\n  ```py\n  b = 2\n  ```\n')).toEqual([
      { language: 'js', code: 'let a = 1;', caption: 'One' },
      { language: 'py', code: 'b = 2', caption: 'Two' },
    ]);
    expect(extractCodeBlocks('-\tOne:\n\n\t```js\n\tlet a = 1;\n## Next\n\n```py\nb\n```\n')).toEqual([
      { language: 'js', code: 'let a = 1;', caption: 'One' },
      { language: 'py', code: 'b', heading: 'Next' },
    ]);
    expect(extractCodeBlocks('- Outer\n\n  - Inner:\n\n    ```js\n    a\n\n  Outer text.\n```py\nb\n```\n')).toEqual([
      { language: 'js', code: 'a', caption: 'Inner' },
      { language: 'py', code: 'b' },
    ]);
    // A closer indented less than the item still closes the fence (where CommonMark would open another).
    expect(extractCodeBlocks('- Step:\n\n  ```js\n  let a = 1;\n```\n\nAfter.\n')).toEqual([
      { language: 'js', code: 'let a = 1;', caption: 'Step' },
    ]);
  });
});
