/**
 * Join report / proposal (DESIGN.md §13.2 row 10, §13.2.1): what kind of picture meets at every cut,
 * the dissolve it has, the handles available, and — only when the project has a join policy
 * (StyleRules.joins, from the brief or the user) — what that policy asks for. Without a policy nothing is
 * proposed: the brief decides.
 */
import { clipSourceNeeds, clipStartFrames, speedCurve } from '../core/project.js';
import { framesToTc, splitDissolve } from '../core/timecode.js';
const DEFAULT_LOGO = 'logo|โลโก้';
function baseName(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}
export function edgeTypeOf(p, clip, opts = {}) {
    const o = opts.overrides ?? {};
    const forced = o[clip.id] ?? (clip.slot !== undefined ? o[clip.slot] : undefined) ?? o[clip.src];
    if (forced)
        return forced;
    const a = p.assets[clip.src];
    const re = new RegExp(opts.logoPattern ?? DEFAULT_LOGO, 'iu');
    const names = [clip.src, clip.slot ?? '', ...(a ? (a.kind === 'aecomp' ? [a.comp] : [baseName(a.path)]) : [])];
    if (names.some((n) => re.test(n.normalize('NFC'))))
        return 'logo';
    if (!a)
        return 'footage';
    return a.kind === 'aecomp' || a.kind === 'still' || a.kind === 'graphic' ? 'card' : 'footage';
}
/** Source frames of an asset (undefined = unknown; Infinity for stills, which hold forever). */
function sourceLength(a) {
    if (!a)
        return undefined;
    if (a.kind === 'still')
        return Infinity;
    if (a.kind === 'aecomp')
        return a.probe?.durationFrames ?? a.render?.frames;
    return a.probe?.durationFrames;
}
const LIMIT = 100_000;
/** Timeline frames past A's out-point the source can still show (speed-aware). */
function handleAfter(p, A) {
    const len = sourceLength(p.assets[A.src]);
    if (len === undefined)
        return undefined;
    if (len === Infinity)
        return null;
    if (!speedCurve(A))
        return Math.max(0, len - (A.in + A.dur));
    if (A.in + clipSourceNeeds(A).end > len)
        return 0;
    // largest b with in + needs(0, b).end <= len (monotone in b)
    let lo = 0;
    let hi = 1;
    while (hi < LIMIT && A.in + clipSourceNeeds(A, 0, hi).end <= len)
        hi *= 2;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (A.in + clipSourceNeeds(A, 0, mid).end <= len)
            lo = mid;
        else
            hi = mid;
    }
    return lo;
}
/** Timeline frames before B's in-point the source can show (speed-aware). */
function handleBefore(p, B) {
    const a = p.assets[B.src];
    if (!a)
        return undefined;
    if (a.kind === 'still')
        return null;
    if (!speedCurve(B))
        return Math.max(0, B.in);
    let lo = 0;
    let hi = 1;
    while (hi < LIMIT && -clipSourceNeeds(B, hi, 0).first <= B.in)
        hi *= 2;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (-clipSourceNeeds(B, mid, 0).first <= B.in)
            lo = mid;
        else
            hi = mid;
    }
    return lo;
}
/** n is possible when a = floor(n/2) <= before and b = n - a <= after: n <= min(2*after, 2*before + 1). */
function maxDissolveOf(after, before) {
    if (after === undefined || before === undefined)
        return undefined;
    const lim = [after === null ? Infinity : 2 * after, before === null ? Infinity : 2 * before + 1];
    const m = Math.min(...lim);
    return m === Infinity ? null : m;
}
const ruleLabel = (r) => `${r.from}→${r.to} ${r.dissolve}f`;
/**
 * The rule for an edge pair: exact match first, then one side '*', then '*'→'*'. A rule also covers the
 * reverse direction (footage→card uses card→footage) unless some rule names that direction.
 */
export function ruleFor(rules, from, to) {
    const pick = (f, t) => rules.find((r) => r.from === f && r.to === t)
        ?? rules.find((r) => r.from === f && r.to === '*')
        ?? rules.find((r) => r.from === '*' && r.to === t);
    const direct = pick(from, to);
    if (direct)
        return { rule: direct, reversed: false };
    const reverse = pick(to, from);
    if (reverse)
        return { rule: reverse, reversed: true };
    const any = rules.find((r) => r.from === '*' && r.to === '*');
    return any ? { rule: any, reversed: false } : undefined;
}
function policyOf(p, rules) {
    if (rules)
        return { kind: 'given', rules };
    const own = p.styleRules?.joins;
    return own && own.length ? { kind: 'styleRules.joins', rules: own } : { kind: 'none', rules: [] };
}
/** Every cut with its edge types, dissolve, handles and (when a policy exists) whether it matches. */
export function joinReport(p, opts = {}) {
    const { kind, rules } = policyOf(p, opts.rules);
    const video = p.timeline.video;
    const dissolveAfter = new Map(p.timeline.cuts.map((c) => [c.after, c.dissolve]));
    const starts = clipStartFrames(p);
    const fps = p.meta.fps;
    const cuts = [];
    const counts = {};
    for (let i = 0; i + 1 < video.length; i++) {
        const A = video[i];
        const B = video[i + 1];
        const at = (starts.get(A.id) ?? 0) + A.dur;
        const from = edgeTypeOf(p, A, opts);
        const to = edgeTypeOf(p, B, opts);
        const handles = { after: handleAfter(p, A), before: handleBefore(p, B) };
        const dissolve = dissolveAfter.get(A.id) ?? 0;
        const hit = rules.length ? ruleFor(rules, from, to) : undefined;
        const row = {
            after: A.id, next: B.id, at, tc: framesToTc(at, fps), from, to, dissolve, handles,
            maxDissolve: maxDissolveOf(handles.after, handles.before),
            match: kind === 'none' ? 'no-policy' : !hit ? 'no-rule' : hit.rule.dissolve === dissolve ? 'match' : 'differs',
            ...(hit ? { policy: { dissolve: hit.rule.dissolve, rule: ruleLabel(hit.rule), ...(hit.reversed ? { reversed: true } : {}) } } : {}),
        };
        cuts.push(row);
        counts[`${from}→${to}`] = (counts[`${from}→${to}`] ?? 0) + 1;
    }
    return {
        policy: kind,
        rules,
        cuts,
        counts,
        note: kind === 'none'
            ? 'ไม่มี join policy ในโปรเจกต์ — บรีฟ/ผู้ใช้เป็นผู้ตัดสิน (ตั้ง styleRules.joins จากบรีฟเมื่อต้องการ) / no join policy: the brief decides'
            : 'policy มาจากบรีฟ/ผู้ใช้ของโปรเจกต์นี้ — ถ้าขัดกับบรีฟ บรีฟชนะ / the policy is per project; the brief wins on conflict',
    };
}
/**
 * Dissolve changes the join policy asks for. No policy (no StyleRules.joins and no rules given) = no
 * proposal at all. A proposal is infeasible when the handles cannot carry it (it is never clamped).
 */
export function proposeJoins(p, opts = {}) {
    const report = joinReport(p, opts);
    if (report.policy === 'none')
        return { report, proposals: [] };
    const proposals = [];
    for (const row of report.cuts) {
        if (row.match !== 'differs' || !row.policy)
            continue;
        const n = row.policy.dissolve;
        const max = row.maxDissolve;
        const feasible = n === 0 || max === null || (max !== undefined && n <= max);
        const { a, b } = splitDissolve(n);
        proposals.push({
            after: row.after, next: row.next, at: row.at, tc: row.tc, from: row.from, to: row.to,
            current: row.dissolve, proposed: n, rule: row.policy.rule, feasible,
            ...(feasible ? {} : {
                reason: max === undefined
                    ? 'source length unknown (probe/render first)'
                    : `needs ${a} frame(s) before '${row.next}' and ${b} after '${row.after}'; handles allow at most ${max}`,
            }),
        });
    }
    return { report, proposals };
}
/** Cuts with the given proposals applied (one entry per changed cut; 0 removes the dissolve). */
export function applyJoinProposals(cuts, proposals) {
    const out = cuts.map((c) => ({ ...c }));
    for (const pr of proposals) {
        const i = out.findIndex((c) => c.after === pr.after);
        if (i >= 0)
            out[i] = { after: pr.after, dissolve: pr.proposed };
        else
            out.push({ after: pr.after, dissolve: pr.proposed });
    }
    return out;
}
//# sourceMappingURL=joins.js.map