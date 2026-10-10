import type { Project, Version } from '../core/types.js';
export interface ReviewServer {
    url: string;
    close(): Promise<void>;
}
/** Serves a single immutable version on loopback (plus read-only proxies of comparable versions); no arbitrary file or command routes. */
export declare function openReview(p: Project, v: Version): Promise<ReviewServer>;
