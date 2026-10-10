import { z } from 'zod';
import type { Asset, Board, BoardSlot, Frames, Project, QcIssue, Timeline } from '../core/types.js';
/**
 * Board time → frames. Accepts "HH:MM:SS:FF", "MM:SS:FF", "M:SS" (minutes:seconds), "M.SS" with two
 * digits after the dot ("0.03" = 3 s, the usual way boards write source TC), "12s" / "12 วิ" / "1.5 sec",
 * "40f", and a bare number = seconds. Returns undefined when it cannot be read.
 */
export declare function parseBoardTime(input: string | number, fps: number): Frames | undefined;
export declare const BoardSlotInputSchema: z.ZodObject<{
    id: z.ZodString;
    order: z.ZodOptional<z.ZodNumber>;
    chapter: z.ZodOptional<z.ZodString>;
    boardStartFrame: z.ZodOptional<z.ZodNumber>;
    boardDurFrames: z.ZodOptional<z.ZodNumber>;
    boardStart: z.ZodOptional<z.ZodString>;
    boardDur: z.ZodOptional<z.ZodString>;
    sourceHint: z.ZodOptional<z.ZodString>;
    sourceTc: z.ZodOptional<z.ZodString>;
    onScreenText: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
    thumb: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<["ok", "mockup", "substitute", "missing"]>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
    order?: number | undefined;
    chapter?: string | undefined;
    boardStartFrame?: number | undefined;
    boardDurFrames?: number | undefined;
    boardStart?: string | undefined;
    boardDur?: string | undefined;
    sourceHint?: string | undefined;
    sourceTc?: string | undefined;
    onScreenText?: string | undefined;
    notes?: string | undefined;
    thumb?: string | undefined;
}, {
    id: string;
    status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
    order?: number | undefined;
    chapter?: string | undefined;
    boardStartFrame?: number | undefined;
    boardDurFrames?: number | undefined;
    boardStart?: string | undefined;
    boardDur?: string | undefined;
    sourceHint?: string | undefined;
    sourceTc?: string | undefined;
    onScreenText?: string | undefined;
    notes?: string | undefined;
    thumb?: string | undefined;
}>;
export declare const BoardInputSchema: z.ZodObject<{
    source: z.ZodOptional<z.ZodString>;
    importedAt: z.ZodOptional<z.ZodString>;
    targetFrames: z.ZodOptional<z.ZodNumber>;
    target: z.ZodOptional<z.ZodString>;
    chapters: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        startFrame: z.ZodOptional<z.ZodNumber>;
        durFrames: z.ZodOptional<z.ZodNumber>;
        start: z.ZodOptional<z.ZodString>;
        dur: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        name: string;
        dur?: string | undefined;
        startFrame?: number | undefined;
        durFrames?: number | undefined;
        start?: string | undefined;
    }, {
        name: string;
        dur?: string | undefined;
        startFrame?: number | undefined;
        durFrames?: number | undefined;
        start?: string | undefined;
    }>, "many">>;
    slots: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        order: z.ZodOptional<z.ZodNumber>;
        chapter: z.ZodOptional<z.ZodString>;
        boardStartFrame: z.ZodOptional<z.ZodNumber>;
        boardDurFrames: z.ZodOptional<z.ZodNumber>;
        boardStart: z.ZodOptional<z.ZodString>;
        boardDur: z.ZodOptional<z.ZodString>;
        sourceHint: z.ZodOptional<z.ZodString>;
        sourceTc: z.ZodOptional<z.ZodString>;
        onScreenText: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
        thumb: z.ZodOptional<z.ZodString>;
        status: z.ZodOptional<z.ZodEnum<["ok", "mockup", "substitute", "missing"]>>;
    }, "strict", z.ZodTypeAny, {
        id: string;
        status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
        order?: number | undefined;
        chapter?: string | undefined;
        boardStartFrame?: number | undefined;
        boardDurFrames?: number | undefined;
        boardStart?: string | undefined;
        boardDur?: string | undefined;
        sourceHint?: string | undefined;
        sourceTc?: string | undefined;
        onScreenText?: string | undefined;
        notes?: string | undefined;
        thumb?: string | undefined;
    }, {
        id: string;
        status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
        order?: number | undefined;
        chapter?: string | undefined;
        boardStartFrame?: number | undefined;
        boardDurFrames?: number | undefined;
        boardStart?: string | undefined;
        boardDur?: string | undefined;
        sourceHint?: string | undefined;
        sourceTc?: string | undefined;
        onScreenText?: string | undefined;
        notes?: string | undefined;
        thumb?: string | undefined;
    }>, "many">;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strict", z.ZodTypeAny, {
    slots: {
        id: string;
        status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
        order?: number | undefined;
        chapter?: string | undefined;
        boardStartFrame?: number | undefined;
        boardDurFrames?: number | undefined;
        boardStart?: string | undefined;
        boardDur?: string | undefined;
        sourceHint?: string | undefined;
        sourceTc?: string | undefined;
        onScreenText?: string | undefined;
        notes?: string | undefined;
        thumb?: string | undefined;
    }[];
    source?: string | undefined;
    warnings?: string[] | undefined;
    importedAt?: string | undefined;
    targetFrames?: number | undefined;
    target?: string | undefined;
    chapters?: {
        name: string;
        dur?: string | undefined;
        startFrame?: number | undefined;
        durFrames?: number | undefined;
        start?: string | undefined;
    }[] | undefined;
}, {
    slots: {
        id: string;
        status?: "ok" | "mockup" | "substitute" | "missing" | undefined;
        order?: number | undefined;
        chapter?: string | undefined;
        boardStartFrame?: number | undefined;
        boardDurFrames?: number | undefined;
        boardStart?: string | undefined;
        boardDur?: string | undefined;
        sourceHint?: string | undefined;
        sourceTc?: string | undefined;
        onScreenText?: string | undefined;
        notes?: string | undefined;
        thumb?: string | undefined;
    }[];
    source?: string | undefined;
    warnings?: string[] | undefined;
    importedAt?: string | undefined;
    targetFrames?: number | undefined;
    target?: string | undefined;
    chapters?: {
        name: string;
        dur?: string | undefined;
        startFrame?: number | undefined;
        durFrames?: number | undefined;
        start?: string | undefined;
    }[] | undefined;
}>;
export type BoardInput = z.infer<typeof BoardInputSchema>;
/** Validated input → Board (time strings converted to frames). Errors are human-readable (Thai + English). */
export declare function normalizeBoard(input: BoardInput, fps: number, source: string): {
    board?: Board;
    errors: string[];
};
/** RFC 4180-ish: quotes, doubled quotes, CR/LF; delimiter auto-detected from the first line (, ; tab). */
export declare function parseCsv(text: string): string[][];
/**
 * CSV board. Header row = BoardSlot field names (case-insensitive, strict: unknown columns are errors).
 * Directive rows: `#target,3:00` and `#chapter,<name>,<start>,<dur>`; other rows starting with # are comments.
 */
export declare function boardInputFromCsv(text: string): {
    input?: BoardInput;
    errors: string[];
};
/** JSON board: a Board-like object ({slots, targetFrames?, chapters?}) or a bare array of slots. */
export declare function boardInputFromJson(text: string): {
    input?: BoardInput;
    errors: string[];
};
export interface PdfMeta {
    pages: number;
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    created?: string;
    modified?: string;
}
export interface PdfPageText {
    page: number;
    width: number;
    height: number;
    /** reading-order lines; cells separated by " | " where the gap is wide (table columns) */
    lines: string[];
}
export interface PdfDetection {
    page: number;
    line: string;
    kind: 'slot' | 'chapter' | 'target';
    value: string;
    confidence: 'high' | 'low';
}
/** "D:20261010120000+07'00'" → ISO string (undefined when unreadable). */
export declare function pdfDateToIso(s: unknown): string | undefined;
/** Text per page (with positions folded into reading-order lines) + document metadata. */
export declare function readPdfText(data: Uint8Array): Promise<{
    meta: PdfMeta;
    pages: PdfPageText[];
}>;
/** Pull slot fields out of one slot's text (row + continuation lines). Exported for tests. */
export declare function parseSlotText(text: string, fps: number): Partial<BoardSlot>;
/** Heuristic draft board from PDF text. The agent (reading the PDF visually) corrects it with board_set. */
export declare function draftBoardFromPdfText(pages: PdfPageText[], fps: number, source: string): {
    board: Board;
    detections: PdfDetection[];
    warnings: string[];
};
export interface BoardFileInfo {
    path: string;
    name: string;
    size: number;
    modified: string;
    sha256: string;
}
export interface BoardSibling {
    name: string;
    modified: string;
    size: number;
    newer: boolean;
}
export interface BoardImportResult {
    format: 'pdf' | 'csv' | 'json';
    file: BoardFileInfo;
    pdf?: PdfMeta;
    pages?: PdfPageText[];
    detections?: PdfDetection[];
    board?: Board;
    errors: string[];
    warnings: string[];
    /** version-ish strings found in the file name / title / first page ("v3", "rev2", "final", "ฉบับที่ 2", dates) */
    versionHints: string[];
    /** other board-like files in the same folder; `newer` ones may be the real latest board */
    siblings: BoardSibling[];
}
export declare function versionHints(texts: string[]): string[];
/** Read a board file (PDF/CSV/JSON). Never writes anything. */
export declare function importBoardFile(file: string, fps: number, opts?: {
    target?: string | number;
}): Promise<BoardImportResult>;
export interface BoardWarning {
    code: 'duplicate-id' | 'duplicate-order' | 'sequence-gap' | 'chapter-vs-slots' | 'chapter-start' | 'chapters-vs-target' | 'slots-vs-target' | 'slot-overlap' | 'slot-gap' | 'start-order' | 'text-mismatch' | 'status' | 'unknown-chapter' | 'footage-missing' | 'footage-orphan' | 'source-missing' | 'no-timing';
    severity: 'error' | 'warn' | 'info';
    message: string;
    slot?: string;
    chapter?: string;
}
/** Contradictions inside the board. `fps` only formats timecodes in messages. */
export declare function checkBoard(board: Board, fps: number): BoardWarning[];
export interface FootageMatch {
    dir: string;
    slots: Array<{
        slot: string;
        matches: string[];
    }>;
    missing: string[];
    orphans: string[];
    warnings: BoardWarning[];
}
/** For every slot: files/folders (depth ≤ 2) whose name starts with the slot id; orphans = numbered entries no slot claims. */
export declare function matchFootage(board: Board, dir: string): Promise<FootageMatch>;
export interface ShotLike {
    id: string;
    src: string;
    start: Frames;
    dur: Frames;
    marker?: string;
    slot?: string;
}
/** Slot id a clip realises: explicit `slot`, else a marker equal to a slot id, else the source file/comp name prefix. */
export declare function inferSlot(shot: ShotLike, board: Board, asset: Asset | undefined): {
    slot?: string;
    how?: 'clip' | 'marker' | 'source';
};
export interface SlotRow {
    slot: string;
    order: number;
    chapter?: string;
    clips: string[];
    boardStart?: Frames;
    boardDur?: Frames;
    cutStart?: Frames;
    cutDur?: Frames;
    startDrift?: Frames;
    durDiff?: Frames;
    boardStartTc?: string;
    cutStartTc?: string;
    startDriftTc?: string;
    status: 'ok' | 'drift' | 'missing' | 'moved' | 'split';
    boardStatus?: BoardSlot['status'];
    onScreenText?: string;
    thumb?: string;
}
export interface ChapterRow {
    name: string;
    boardStart?: Frames;
    boardDur?: Frames;
    cutStart?: Frames;
    cutDur?: Frames;
    startDrift?: Frames;
    durDiff?: Frames;
    startDriftTc?: string;
    durDiffTc?: string;
}
export interface BoardVsCut {
    fps: number;
    toleranceFrames: Frames;
    slots: SlotRow[];
    chapters: ChapterRow[];
    missing: string[];
    extra: Array<{
        clipId: string;
        start: Frames;
        dur: Frames;
        slot?: string;
        reason: 'no-slot' | 'unknown-slot';
    }>;
    moved: string[];
    total: {
        cut: Frames;
        cutTc: string;
        target?: Frames;
        targetTc?: string;
        diff?: Frames;
        diffTc?: string;
    };
    issues: QcIssue[];
    summary: string[];
}
/** Compare a cut (shots with resolved slot ids, in timeline order) with the board. Pure. */
export declare function compareBoardToCut(board: Board, shots: ShotLike[], totalFrames: Frames, fps: number, toleranceFrames: Frames): BoardVsCut;
/** Path usable from an HTML file in `fromDir`: relative when possible, else file:/// URL. */
export declare function htmlHref(target: string, fromDir: string): string;
export interface ReportImages {
    board?: string;
    cut?: string;
    cutFrame?: Frames;
}
export declare function renderBoardVsCutHtml(r: BoardVsCut, opts: {
    title: string;
    version: string;
    master?: string;
    images: Map<string, ReportImages>;
    notes?: string[];
}): string;
export type FitStrategy = 'proportional' | 'tail' | 'cards';
export interface FitChange {
    clipId: string;
    slot?: string;
    from: Frames;
    to: Frames;
    delta: Frames;
    min: Frames;
    max: Frames | null;
}
export interface FitProposal {
    strategy: FitStrategy;
    currentFrames: Frames;
    targetFrames: Frames;
    delta: Frames;
    achievedFrames: Frames;
    remaining: Frames;
    flexible: string[];
    changes: FitChange[];
    timeline: Timeline;
    errors: string[];
    notes: string[];
}
/** Split `total` (>0) across items proportionally to weight, never exceeding cap; integer frames. */
export declare function distribute(total: number, items: Array<{
    w: number;
    cap: number;
}>): number[];
/**
 * Propose clip durations that make the timeline `targetFrames` long. In-points never move; growth is
 * limited by the source length minus the handle the following dissolve needs, shrink by the frames the
 * dissolves on both sides consume (+1 body frame). The proposal is verified with validateTimeline.
 */
export declare function proposeFit(p: Project, opts: {
    targetFrames: Frames;
    strategy: FitStrategy;
    board?: Board;
    flexible?: string[];
    lock?: string[];
    shiftAudio?: boolean;
}): FitProposal;
