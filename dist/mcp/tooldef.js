import { card, UserActionError } from '../core/user-action.js';
/** Told to the agent next to every card: show it as is, then wait. */
export const RELAY = 'Show userAction.say to the user exactly as written (Thai), then stop and wait for their reply. Do not invent other steps.';
/** A tool failure that needs the person to do something (DESIGN.md §14). */
export function needsUser(message, action, data = {}) {
    return new ToolError(message, { ...data, userAction: card(action), relay: RELAY });
}
/** Throw to return a structured failure (data is merged into the JSON body). */
export class ToolError extends Error {
    data;
    constructor(message, data = {}) {
        super(message);
        this.data = data;
    }
}
export function tool(def) {
    return def;
}
export function json(data) {
    return JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
}
export function ok(data) {
    return { content: [{ type: 'text', text: json(data) }] };
}
export function fail(err) {
    const body = err instanceof ToolError
        ? { ok: false, error: err.message, ...err.data }
        : err instanceof UserActionError
            ? { ok: false, error: err.message, userAction: card(err.userAction), relay: RELAY }
            : { ok: false, error: err instanceof Error ? err.message : String(err) };
    return { isError: true, content: [{ type: 'text', text: json(body) }] };
}
//# sourceMappingURL=tooldef.js.map