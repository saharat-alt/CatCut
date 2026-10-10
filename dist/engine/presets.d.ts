import type { DeliveryPreset, DeliveryTargetId, Environment } from '../core/types.js';
/**
 * Delivery targets. Loudness is what the deliverable is normalised to; the ProRes master
 * itself is mixed to `MASTER_PRESET_ID`'s loudness (EBU R128: -23 LUFS / -1 dBTP).
 */
export declare const PRESETS: Record<string, DeliveryPreset>;
/** The preset whose loudness the ProRes master is mixed to. */
export declare const MASTER_PRESET_ID: DeliveryTargetId;
export declare function resolvePreset(id: DeliveryTargetId, overrides?: Partial<DeliveryPreset>): DeliveryPreset;
export interface FfmpegPresetArgs {
    videoArgs: string[];
    audioArgs: string[];
    container: string;
    ext: string;
}
/** Encoder arguments only; scaling / fps / interlace filters are the caller's job. */
export declare function presetToFfmpegArgs(preset: DeliveryPreset, env: Environment, opts: {
    width: number;
    height: number;
    fps: number;
}): FfmpegPresetArgs;
