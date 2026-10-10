/**
 * Shared MCP tool plumbing. Feature modules (tools-*.ts) export `ToolDef[]` built with `tool()`;
 * tools.ts concatenates them into TOOLS.
 */
import type { z } from 'zod';
import type { AppState } from './state.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Throw to return a structured failure (data is merged into the JSON body). */
export class ToolError extends Error {
  constructor(message: string, public readonly data: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  // `never` lets each tool keep its precise inferred arg type without a cast at definition time.
  handler: (args: never, state: AppState) => Promise<unknown>;
  /** true: changes the project (blocked while a build/deliver/review job runs). */
  mutating?: boolean;
  /** true: writes into the open project's folder (blocked for protected paths). */
  writesProject?: boolean;
}

export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, state: AppState) => Promise<unknown>;
  mutating?: boolean;
  writesProject?: boolean;
}): ToolDef {
  return def as ToolDef;
}

export function json(data: unknown): string {
  return JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: json(data) }] };
}

export function fail(err: unknown): ToolResult {
  const body = err instanceof ToolError
    ? { ok: false, error: err.message, ...err.data }
    : { ok: false, error: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: json(body) }] };
}
