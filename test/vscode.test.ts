/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The VS Code workspace entries and the guide that lists them
 * (docs/vscode-setup.md) must agree: every row names an entry that exists,
 * every entry has a row, and each entry runs the command its row gives —
 * after a build exactly when the row says "Build, then", with the environment
 * the row names, its dependencies in turn exactly when the row says so. The
 * guide's account of `npm run release` must be what scripts/release.js does,
 * and every guide spells the product "Magic Lane".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

interface Task {
  label: string;
  command?: string;
  args?: string[];
  dependsOn?: string[];
  dependsOrder?: 'sequence' | 'parallel';
  options?: { env?: Record<string, string> };
}
interface Launch {
  name: string;
  runtimeExecutable?: string;
  program?: string;
  runtimeArgs?: string[];
  args?: string[];
  env?: Record<string, string>;
  preLaunchTask?: string;
}

const tasks = (JSON.parse(read('.vscode/tasks.json')) as { tasks: Task[] }).tasks;
const launches = (JSON.parse(read('.vscode/launch.json')) as { configurations: Launch[] }).configurations;
const guide = read('docs/vscode-setup.md');

/** The rows of the guide's tables: the entry (bold for launch configurations) and its description. */
const rows = [...guide.matchAll(/^\| (\*\*)?(Magic Lane: [^|*]+?)(?:\*\*)? +\| (.*?) +\|$/gm)].map((m) => ({
  launch: m[1] !== undefined,
  name: m[2] as string,
  description: m[3] as string,
}));
const guideRows = rows.map((r) => r.name);

/** The entry a row describes. */
const entryOf = (row: { launch: boolean; name: string }): Task | Launch | undefined =>
  row.launch ? launches.find((l) => l.name === row.name) : tasks.find((t) => t.label === row.name);

/** The command an entry runs, as the guide writes it: the runtime's arguments, the program, then the program's own. */
function commandOf(entry: Task | Launch): string | undefined {
  const words =
    'label' in entry
      ? entry.command === undefined
        ? undefined
        : [entry.command, ...(entry.args ?? [])]
      : entry.runtimeExecutable !== undefined
        ? [entry.runtimeExecutable, ...(entry.runtimeArgs ?? []), ...(entry.args ?? [])]
        : ['node', ...(entry.runtimeArgs ?? []), entry.program as string, ...(entry.args ?? [])];
  return words?.join(' ').replaceAll('${workspaceFolder}/', '').replaceAll('${relativeFile}', '<open file>');
}

/** Whether an entry builds first. */
function buildsFirst(entry: Task | Launch): boolean {
  return 'label' in entry
    ? (entry.dependsOn ?? []).includes('Magic Lane: Build')
    : entry.preLaunchTask === 'Magic Lane: Build';
}

/** The environment an entry sets: a launch configuration's `env`, a task's `options.env`. */
function envOf(entry: Task | Launch): string[] {
  const env = ('label' in entry ? entry.options?.env : entry.env) ?? {};
  return Object.entries(env).map(([name, value]) => `${name}=${value}`);
}

describe('VS Code workspace entries and their guide', () => {
  it('lists every task and launch configuration, and only those', () => {
    const entries = [...launches.map((l) => l.name), ...tasks.map((t) => t.label)];
    expect([...guideRows].sort()).toEqual([...entries].sort());
  });

  it('gives, for every entry, the command it runs, and says "Build, then" exactly when it builds first', () => {
    for (const row of rows) {
      const entry = entryOf(row);
      expect(entry, row.name).toBeDefined();
      const command = commandOf(entry!);
      if (command === undefined) continue; // Verify: it only runs the others
      const said = /^(Build, then )?`([^`]+)`/.exec(row.description);
      expect(said?.[2], row.name).toBe(command);
      expect(said?.[1] !== undefined, `${row.name}: "Build, then"`).toBe(buildsFirst(entry!));
    }
    const verify = rows.find((r) => r.name === 'Magic Lane: Verify (all local gates)')!;
    const runs = (tasks.find((t) => t.label === verify.name)?.dependsOn ?? []).map((d) =>
      d.replace('Magic Lane: ', '')
    );
    expect(verify.description).toContain(`Runs ${runs.slice(0, -1).join(', ')} and ${runs.at(-1)} in turn`);
  });

  it('sets, for every entry, exactly the environment variables its row names as `NAME=value`', () => {
    for (const row of rows) {
      const said = [...row.description.matchAll(/`([A-Z][A-Z0-9_]*)=([^`\s]+)`/g)].map((m) => `${m[1]}=${m[2]}`);
      expect(said.sort(), row.name).toEqual(envOf(entryOf(row)!).sort());
    }
    // The rows' form is the one this reads: the dev servers' and the integration configuration's are counted.
    expect(rows.filter((row) => envOf(entryOf(row)!).length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('runs the dependencies of a task in turn exactly when its row says so', () => {
    for (const task of tasks) {
      if ((task.dependsOn?.length ?? 0) < 2) continue; // one dependency runs in no order
      const row = rows.find((r) => r.name === task.label)!;
      expect(/\bin turn\b/.test(row.description), task.label).toBe(task.dependsOrder === 'sequence');
    }
    // The gates need the build before them, so Verify runs them in turn.
    expect(tasks.find((t) => t.label === 'Magic Lane: Verify (all local gates)')?.dependsOrder).toBe('sequence');
  });

  it('spells the product "Magic Lane" everywhere: the workspace files, the README and every guide', () => {
    const guides = readdirSync(new URL('../docs/', import.meta.url))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `docs/${name}`);
    expect(guides).toEqual(expect.arrayContaining(['docs/vscode-setup.md', 'docs/vs-setup.md']));
    for (const path of ['.vscode/tasks.json', '.vscode/launch.json', 'README.md', ...guides]) {
      expect(read(path), path).not.toContain('MagicLane');
    }
  });

  it('runs every dependency it names', () => {
    const labels = new Set(tasks.map((t) => t.label));
    for (const t of tasks) for (const d of t.dependsOn ?? []) expect(labels, `${t.label} → ${d}`).toContain(d);
    for (const l of launches) if (l.preLaunchTask) expect(labels, l.name).toContain(l.preLaunchTask);
  });

  it('runs the live suite the way npm run test:live does', () => {
    const task = tasks.find((t) => t.label === 'Magic Lane: Run Integration Tests');
    expect([task?.command, ...(task?.args ?? [])]).toEqual(['npm', 'run', 'test:live']);
    const debug = launches.find((l) => l.name === 'Magic Lane: Debug Integration Tests (needs build)');
    expect(debug?.runtimeArgs).toContain('test/integration.test.ts');
    expect(debug?.env?.LIVE_DOCS_TESTS).toBe('1'); // without it the test config leaves the file out
  });

  it('pins mcpb to the version the release uses, and verifies the manifest both ways', () => {
    const pinned = /const MCPB = '(@anthropic-ai\/mcpb@[\d.]+)'/.exec(read('scripts/release.js'))?.[1];
    const validate = tasks.find((t) => t.label === 'Magic Lane: Validate MCP Manifest');
    expect(validate?.args).toContain(pinned);
    expect(guide).toContain(`npx --yes ${pinned} validate manifest.json`);
    const verify = tasks.find((t) => t.label === 'Magic Lane: Verify (all local gates)');
    expect(verify?.dependsOn).toEqual(
      expect.arrayContaining(['Magic Lane: Check Manifest Tools', 'Magic Lane: Validate MCP Manifest'])
    );
  });

  it('describes npm run release as scripts/release.js runs it: its checks, check, reuse lint (pinned), the audit, packing', () => {
    const release = read('scripts/release.js');
    const reuse = /const REUSE = '([\d.]+)'/.exec(release)?.[1];
    expect(reuse).toBeDefined();
    // The steps, in the order the script runs them.
    const steps = [
      "run('npm ci')",
      "run('npm run check')",
      'run(reuse)',
      "run('npm audit --omit=dev')",
      '${MCPB} pack',
    ];
    const at = steps.map((step) => release.indexOf(step));
    expect(at, steps.join(', ')).not.toContain(-1);
    expect(
      at.every((i, n) => n === 0 || i > at[n - 1]!),
      steps.join(' < ')
    ).toBe(true);
    const said = /`npm run release`\s+\((.*?)\)\s+runs\s+(.*?), before packing\./s.exec(guide);
    expect(said?.[1]?.replace(/\s+/g, ' ')).toBe(
      `from a clean git clone, with REUSE ${reuse} at hand and the CHANGELOG entry dated today`
    );
    expect(said?.[2]?.replace(/\s+/g, ' ')).toBe('`check` (which builds first), then `reuse lint` and the audit');
    // What the guide says it needs is what the script checks before it installs anything: the top of a checkout
    // with a clean tree (nothing hidden, no ignored file that would ship), REUSE, and the CHANGELOG dated today.
    const checks = release.slice(0, release.indexOf("run('npm ci')"));
    const needs = ['inGitCheckout()', 'git status --porcelain', 'hiddenTracked(', 'shippingIgnored(', 'reuseLint()'];
    for (const need of [...needs, 'changelogProblem(', 'localDate()']) expect(checks, need).toContain(need);
  });
});
