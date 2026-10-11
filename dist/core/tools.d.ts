import type { Encoders, Environment, ToolPaths } from './types.js';
/** Find ffmpeg/ffprobe: env EDITMCP_FFMPEG, PATH, then the winget install folder. */
export declare function findFfmpeg(): {
    ffmpeg: string;
    ffprobe: string;
} | undefined;
/** Newest "Adobe After Effects 20xx" under Program Files (or EDITMCP_AE_DIR). */
export declare function findAfterEffects(): Pick<ToolPaths, 'afterfx' | 'aerender' | 'aeVersionDir'>;
export declare function findPremiere(): Pick<ToolPaths, 'premiereExe' | 'mediaEncoderExe'>;
/**
 * ArtCraft headless CLIs (optional): EDITMCP_FILMCRAFT_DIR / EDITMCP_EFFECTCRAFT_DIR (e.g. a portable
 * zip), else the MSI install folders under Program Files.
 */
export declare function findArtCraft(): Pick<ToolPaths, 'filmcraftCli' | 'effectcraftCli'>;
export declare function discoverTools(): ToolPaths;
export declare function probeEncoders(ffmpeg: string): Promise<Encoders & {
    version?: string;
}>;
export declare function getEnvironment(): Promise<Environment>;
