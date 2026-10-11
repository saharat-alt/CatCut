import { type SpawnFn } from './aerender.js';
export declare const BRIDGE_ID = "com.catcut.bridge";
export interface PremiereProjectRef {
    name: string;
    path: string;
}
export interface PremiereSequenceRef {
    name: string;
    id: string;
    active?: boolean;
}
export interface PremiereBridgeStatus {
    /** extension folder present under %APPDATA%\Adobe\CEP\extensions */
    installed: boolean;
    installDir: string;
    /** a bridge heartbeat younger than staleMs */
    connected: boolean;
    queueDir: string;
    premiere?: string;
    bridge?: string;
    project?: PremiereProjectRef | null;
    heartbeatAgeMs?: number;
}
export interface PremiereClient {
    status(): Promise<PremiereBridgeStatus>;
    /** Run one bridge action; rejects with Premiere's error text. */
    call<T>(action: string, args?: Record<string, unknown>, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    /** Folder both sides can read and write (ASCII). */
    readonly queueDir: string;
}
export declare function defaultQueueDir(): string;
export declare function cepExtensionsDir(): string;
export declare function createPremiereClient(opts?: {
    queueDir?: string;
    staleMs?: number;
    pollMs?: number;
    installDir?: string;
}): PremiereClient;
/** A unique ASCII file in the queue folder for Premiere to read or write. */
export declare function stagePath(client: PremiereClient, ext: string): Promise<string>;
export declare function bridgeSourceDir(): string;
export interface InstallResult {
    installedTo: string;
    debugModeKeys: string[];
}
/**
 * Copies the extension into the user's CEP folder (replacing an older CatCut bridge only) and sets
 * PlayerDebugMode=1 for the CEP runtimes, which lets Premiere load an unsigned extension.
 */
export declare function installBridge(opts?: {
    spawn?: SpawnFn;
    source?: string;
    extensionsDir?: string;
}): Promise<InstallResult>;
/** Removes the extension folder (PlayerDebugMode stays: other unsigned extensions may need it). */
export declare function uninstallBridge(opts?: {
    extensionsDir?: string;
}): Promise<string>;
