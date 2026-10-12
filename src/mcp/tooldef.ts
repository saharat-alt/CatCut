/**
 * Shared MCP tool plumbing. Feature modules (tools-*.ts) export `ToolDef[]` built with `tool()`;
 * tools.ts concatenates them into TOOLS.
 */
import type { z } from 'zod';
import type { UserAction } from '../core/types.js';
import { card, UserActionError } from '../core/user-action.js';
import type { AppState } from './state.js';

/** Told to the agent next to every card: show it as is, then wait. */
export const RELAY = 'Show userAction.say to the user exactly as written (Thai), then stop and wait for their reply. Do not invent other steps.';

/** A tool failure that needs the person to do something (DESIGN.md §14). */
export function needsUser(message: string, action: UserAction, data: Record<string, unknown> = {}): ToolError {
  return new ToolError(message, { ...data, userAction: card(action), relay: RELAY });
}

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
    : err instanceof UserActionError
      ? { ok: false, error: err.message, userAction: card(err.userAction), relay: RELAY }
      : { ok: false, error: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: json(body) }] };
}
