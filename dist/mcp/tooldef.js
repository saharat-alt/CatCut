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
        : { ok: false, error: err instanceof Error ? err.message : String(err) };
    return { isError: true, content: [{ type: 'text', text: json(body) }] };
}
//# sourceMappingURL=tooldef.js.map