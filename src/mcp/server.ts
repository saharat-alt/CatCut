/**
 * EDITMCP stdio server. `createServer()` is exported for tests (InMemoryTransport);
 * running this file directly (`tsx src/mcp/server.ts` / `node dist/mcp/server.js`) serves on stdio.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAppState, type AppState } from './state.js';
import { runTool, TOOLS } from './tools.js';

const SERVER_INFO = { name: 'editmcp', version: '0.1.0' } as const;

const INSTRUCTIONS = [
  'EDITMCP: headless video editing (After Effects headless + aerender + ffmpeg). ทุกเวลาเป็นเฟรมที่ fps ของโปรเจกต์ (ไม่ใช่วินาที).',
  'Flow: doctor → project_new/project_open → asset_add → timeline_set (or timeline_edit / audio_add) → build (returns job id; poll job_status) → deliver → export_premiere_xml.',
  'Premiere loop: export_premiere_xml → edit in Premiere → File > Export > Final Cut Pro XML → import_premiere_xml → build.',
  'Review: review_open → job_status URL → user selects shots/ranges and annotates → review_notes. Propose edits from submitted notes before applying them.',
  'Builds are incremental: unchanged segments are never re-encoded; outputs are never overwritten (new version each build).',
].join('\n');

export async function createServer(state?: AppState): Promise<McpServer> {
  const st = state ?? (await createAppState());
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input }, (args) => runTool(t, args, st));
  }
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    onclose?.();
    for (const review of st.reviews?.values() ?? []) void review.close();
    st.reviews?.clear();
  };
  return server;
}

/** Serve on stdio. Logs go to stderr only (stdout is the protocol channel). */
export async function serveStdio(opts: { projectDir?: string } = {}): Promise<void> {
  const state = await createAppState();
  if (opts.projectDir) {
    // A bad path must not stop the server: the agent can project_open later.
    try {
      state.project = await state.api.project.loadProject(opts.projectDir);
    } catch (err) {
      state.problems.push(`project not opened: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const server = await createServer(state);
  await server.connect(new StdioServerTransport());
  const note = state.problems.length ? ` (problems: ${state.problems.join('; ')})` : '';
  process.stderr.write(`editmcp ${SERVER_INFO.version} ready on stdio${note}\n`);
}

/** True when this module is the process entry point (works for both tsx and compiled dist). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = resolve(fileURLToPath(metaUrl));
    const b = resolve(entry);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  serveStdio().catch((err: unknown) => {
    process.stderr.write(`editmcp failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
