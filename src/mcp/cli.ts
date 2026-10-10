#!/usr/bin/env node
/**
 * editmcp CLI: doctor | serve [projectDir] | build <projectDir> [--force] [--skip-qc] [--skip-deliver]
 *              | deliver <projectDir> <version> <targets...> | xml-export <projectDir> [--version v001]
 *              | xml-import <projectDir> <xml>
 */
import { parseArgs } from 'node:util';
import { isMain, serveStdio } from './server.js';
import { createAppState, type AppState } from './state.js';
import { callTool, toolResultData, type ToolResult } from './tools.js';

const USAGE = `editmcp — headless video editing MCP (After Effects headless + aerender + ffmpeg)

  editmcp doctor                                   ตรวจเครื่องมือ / check tools, encoders, RAM, compat notes
  editmcp serve [projectDir]                       MCP stdio server (ใช้กับ Claude Code / Codex)
  editmcp build <projectDir> [--force] [--skip-qc] [--skip-deliver]
  editmcp deliver <projectDir> <version> <targets...>   e.g. v001 yt th_tv
  editmcp xml-export <projectDir> [--version v001] [--name SeqName]
  editmcp xml-import <projectDir> <file.xml>
  editmcp review <projectDir> [--version v001]        เปิดหน้ารีวิวในเครื่อง (Ctrl+C เพื่อปิด server)

  EDITMCP_ALLOW_AE=1   doctor may launch After Effects to read its version (off by default)
`;

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** Print the tool result; returns the data, or null on failure (already printed). */
function report(r: ToolResult): Record<string, unknown> | null {
  const data = toolResultData(r);
  if (r.isError) { err(pretty(data)); return null; }
  return data;
}

/** Poll a job, printing new log lines to stderr, until it ends. */
async function tailJob(state: AppState, id: string): Promise<Record<string, unknown> | null> {
  let printed = 0;
  for (;;) {
    const j = state.jobs.get(id);
    if (!j) { err(`job ${id} vanished`); return null; }
    for (const line of j.log.slice(printed)) err(`  ${line}`);
    printed = j.log.length;
    if (j.status === 'done') return (j.result as Record<string, unknown>) ?? {};
    if (j.status === 'failed' || j.status === 'cancelled') { err(`${j.name} ${j.status}: ${j.error ?? ''}`); return null; }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function printDoctor(d: Record<string, unknown>): void {
  const tools = d['tools'] as Record<string, string | undefined>;
  const enc = d['encoders'] as Record<string, boolean>;
  const ram = d['ram'] as { totalGb: number; freeGb: number; low: boolean };
  out(`EDITMCP doctor ${d['ok'] ? 'OK' : 'PROBLEMS'}`);
  out('');
  out('tools');
  for (const k of ['ffmpeg', 'ffprobe', 'afterfx', 'aerender', 'aeVersionDir', 'premiereExe', 'mediaEncoderExe']) out(`  ${k.padEnd(16)} ${tools[k] ?? '-'}`);
  out(`  ffmpeg version   ${d['ffmpegVersion'] ?? '-'}`);
  out(`  AE version       ${d['aeVersion']}`);
  out('');
  out(`encoders  ${Object.entries(enc).map(([k, v]) => `${v ? '+' : '-'}${k}`).join('  ')}`);
  out(`gpu       ${d['gpu']}`);
  out(`ram       ${ram.totalGb} GB total, ${ram.freeGb} GB free${ram.low ? '  (LOW — render one thing at a time)' : ''}`);
  out(`cpu       ${d['cpuThreads']} threads`);
  const problems = d['problems'] as string[];
  if (problems.length) { out(''); out('problems'); for (const p of problems) out(`  ! ${p}`); }
  out('');
  out('compat notes (docs/DESIGN.md)');
  for (const n of d['compat'] as string[]) out(`  - ${n}`);
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      'skip-qc': { type: 'boolean', default: false },
      'skip-deliver': { type: 'boolean', default: false },
      version: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help) { out(USAGE); return 0; }
  if (!cmd) { out(USAGE); return 1; }

  const needDir = (): string => {
    const d = rest[0];
    if (!d) { err(USAGE); throw new Error(`${cmd}: projectDir required`); }
    return d;
  };

  switch (cmd) {
    case 'doctor': {
      const state = await createAppState();
      const d = report(await callTool(state, 'doctor'));
      if (!d) return 1;
      printDoctor(d);
      return d['ok'] ? 0 : 2;
    }
    case 'serve':
      await serveStdio({ projectDir: rest[0] });
      return null; // keep running
    case 'review': {
      const state = await createAppState({ projectDir: needDir() });
      const started = report(await callTool(state, 'review_open', { version: values.version }));
      if (!started) return 1;
      const result = await tailJob(state, String(started['jobId']));
      if (!result) return 1;
      out(String(result['url']));
      err('Review server is running on this computer. Ctrl+C to close; notes stay on disk.');
      const close = () => { void Promise.all([...state.reviews?.values() ?? []].map(r => r.close())).then(() => { process.exitCode = 0; }); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      return null;
    }
    case 'build': {
      const state = await createAppState({ projectDir: needDir() });
      const started = report(await callTool(state, 'build', { force: values.force, skipQc: values['skip-qc'], skipDeliver: values['skip-deliver'] }));
      if (!started) return 1;
      const result = await tailJob(state, String(started['jobId']));
      if (!result) return 1;
      out(pretty(result));
      return 0;
    }
    case 'deliver': {
      const [, version, ...targets] = rest;
      const state = await createAppState({ projectDir: needDir() });
      const started = report(await callTool(state, 'deliver', { version, targets: targets.length ? targets : undefined }));
      if (!started) return 1;
      const result = await tailJob(state, String(started['jobId']));
      if (!result) return 1;
      out(pretty(result));
      return 0;
    }
    case 'xml-export': {
      const state = await createAppState({ projectDir: needDir() });
      const d = report(await callTool(state, 'export_premiere_xml', { version: values.version, sequenceName: values.name }));
      if (!d) return 1;
      out(String(d['path']));
      return 0;
    }
    case 'xml-import': {
      const dir = needDir();
      const xml = rest[1];
      if (!xml) { err(USAGE); return 1; }
      const state = await createAppState({ projectDir: dir });
      const d = report(await callTool(state, 'import_premiere_xml', { path: xml }));
      if (!d) return 1;
      out(pretty({ diff: d['diff'], warnings: d['warnings'], unresolvedPaths: d['unresolvedPaths'] }));
      return 0;
    }
    default:
      err(`unknown command: ${cmd}\n`);
      err(USAGE);
      return 1;
  }
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => { if (code !== null) process.exitCode = code; },
    (e: unknown) => { err(e instanceof Error ? e.message : String(e)); process.exitCode = 1; },
  );
}
