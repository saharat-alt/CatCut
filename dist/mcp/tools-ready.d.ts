import type { UserAction } from '../core/types.js';
import { type AeScriptingPref } from '../engine/housekeeping.js';
import type { AppState } from './state.js';
import { type ToolDef } from './tooldef.js';
export interface AppReadiness {
    app: UserAction['app'];
    /** ok: nothing to do · action: the person must do `userAction` · optional: not installed, only some tools need it */
    status: 'ok' | 'action' | 'optional';
    /** does the app have to be open while CatCut works */
    keepOpen: 'never' | 'catcut-opens-it' | 'while-working';
    note: string;
    userAction?: UserAction & {
        say: string;
    };
}
export interface Readiness {
    ready: boolean;
    apps: AppReadiness[];
    /** Thai summary for the person */
    say: string;
}
export interface ReadinessDeps {
    aePref?: () => Promise<AeScriptingPref>;
    freeGb?: (path: string) => Promise<number | undefined>;
}
export declare function readiness(state: AppState, deps?: ReadinessDeps): Promise<Readiness>;
export declare const READY_TOOLS: ToolDef[];
