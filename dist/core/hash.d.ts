/**
 * Fast content fingerprint: sha1 of size + mtime + first 1 MiB + last 1 MiB.
 * Deliberately does not read the middle of large media files, so a same-size
 * in-place edit that preserves mtime is not detected.
 */
export declare function hashFile(path: string): Promise<string>;
export declare function hashString(s: string): string;
/** Stable hash of any JSON-like value: key order never matters, array order does. */
export declare function hashJson(v: unknown): string;
