import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type AppState } from './state.js';
export declare function createServer(state?: AppState): Promise<McpServer>;
/** Serve on stdio. Logs go to stderr only (stdout is the protocol channel). */
export declare function serveStdio(opts?: {
    projectDir?: string;
}): Promise<void>;
/** True when this module is the process entry point (works for both tsx and compiled dist). */
export declare function isMain(metaUrl: string): boolean;
