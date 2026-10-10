import { describe, expect, it } from 'vitest';
import type { Project, Timeline } from '../../src/core/types.js';
import { validateTimeline } from '../../src/core/project.js';
import { applyJoinProposals, edgeTypeOf, joinReport, proposeJoins, ruleFor } from '../../src/engine/joins.js';

function project(timeline: Timeline, joins?: Array<{ from: string; to: string; dissolve: number }>): Project {
  return {
    meta: { name: 'j', fps: 25, width: 1920, height: 1080, createdAt: '2026-01-01T00:00:00.000Z', schema: 1 },
    dir: 'D:\\EDITMCP\\tmp\\joins',
    assets: {
      cam: { id: 'cam', kind: 'camera', path: 'D:\\f\\a.mp4', probe: { durationFrames: 500, hasVideo: true, hasAudio: false } },
      card: {
        id: 'card', kind: 'aecomp', aep: 'D:\\f\\t.aep', comp: 'Card 01',
        render: { path: 'D:\\f\\card.mov', frames: 200, fingerprint: 'x', renderedAt: '2026-01-01T00:00:00.000Z' },
        probe: { durationFrames: 200, hasVideo: true, hasAudio: false },
      },
      endlogo: { id: 'endlogo', kind: 'still', path: 'D:\\f\\โลโก้ท้าย.png', probe: { durationFrames: 1, hasVideo: true, hasAudio: false } },
    },
    timeline,
    delivery: { targets: [] },
    versions: [],
    ...(joins ? { styleRules: { joins } } : {}),
  };
}

const base = (): Timeline => ({
  video: [
    { id: 'f1', src: 'cam', in: 20, dur: 50 },
    { id: 'c1', src: 'card', in: 10, dur: 60 },
    { id: 'f2', src: 'cam', in: 100, dur: 50 },
    { id: 'f3', src: 'cam', in: 3, dur: 40, speed: { rate: 0.5 } },
    { id: 'l1', src: 'endlogo', in: 0, dur: 40 },
  ],
  cuts: [{ after: 'c1', dissolve: 6 }],
  audio: { vo: [], music: [], sfx: [] },
});

describe('edge types', () => {
  it('classifies card / footage / logo (Thai name), with overrides and a custom pattern', () => {
    const p = project(base());
    const types = p.timeline.video.map((c) => edgeTypeOf(p, c));
    expect(types).toEqual(['footage', 'card', 'footage', 'footage', 'logo']);
    expect(edgeTypeOf(p, p.timeline.video[1]!, { logoPattern: 'card 0\\d' })).toBe('logo');
    expect(edgeTypeOf(p, p.timeline.video[0]!, { overrides: { cam: 'interview' } })).toBe('interview');
    expect(edgeTypeOf(p, { ...p.timeline.video[0]!, slot: '07' }, { overrides: { '07': 'card', cam: 'x' } })).toBe('card');
  });
});

describe('joinReport', () => {
  it('without a policy reports every cut (edge types, dissolve, speed-aware handles) and proposes nothing', () => {
    const p = project(base());
    const r = joinReport(p);
    expect(r.policy).toBe('none');
    expect(r.cuts.map((c) => [c.after, c.from, c.to, c.dissolve, c.match])).toEqual([
      ['f1', 'footage', 'card', 0, 'no-policy'],
      ['c1', 'card', 'footage', 6, 'no-policy'],
      ['f2', 'footage', 'footage', 0, 'no-policy'],
      ['f3', 'footage', 'logo', 0, 'no-policy'],
    ]);
    expect(r.cuts[0]).toMatchObject({ at: 50, tc: '00:00:02:00', handles: { after: 500 - 70, before: 10 }, maxDissolve: 21 });
    // f3 at 50%: 40 frames use 20 source frames; 3 source frames before its in = 6 timeline frames of handle
    expect(r.cuts[2]!.handles.before).toBe(6);
    expect(r.cuts[3]!.handles).toEqual({ after: 2 * (500 - 23), before: null }); // still: unlimited
    expect(r.counts).toEqual({ 'footage→card': 1, 'card→footage': 1, 'footage→footage': 1, 'footage→logo': 1 });
    expect(proposeJoins(p).proposals).toEqual([]);
  });

  it('with StyleRules.joins: matches rules (reverse direction, wildcards) and proposes only differing, feasible changes', () => {
    const rules = [
      { from: 'card', to: 'footage', dissolve: 10 },
      { from: 'footage', to: 'footage', dissolve: 0 },
      { from: '*', to: 'logo', dissolve: 14 },
    ];
    const p = project(base(), rules);
    const r = joinReport(p);
    expect(r.policy).toBe('styleRules.joins');
    expect(r.cuts.map((c) => [c.after, c.policy?.dissolve, c.policy?.reversed ?? false, c.match])).toEqual([
      ['f1', 10, true, 'differs'],
      ['c1', 10, false, 'differs'],
      ['f2', 0, false, 'match'],
      ['f3', 14, false, 'differs'],
    ]);
    const { proposals } = proposeJoins(p);
    expect(proposals.map((x) => [x.after, x.current, x.proposed, x.feasible])).toEqual([
      ['f1', 0, 10, true],
      ['c1', 6, 10, true],
      ['f3', 0, 14, true],
    ]);
    const next = { ...p, timeline: { ...p.timeline, cuts: applyJoinProposals(p.timeline.cuts, proposals) } };
    expect(next.timeline.cuts).toEqual([{ after: 'c1', dissolve: 10 }, { after: 'f1', dissolve: 10 }, { after: 'f3', dissolve: 14 }]);
    expect(validateTimeline(next)).toEqual([]);
  });

  it('marks a proposal infeasible (never clamps) when the handles cannot carry it; rules passed in override the project', () => {
    const t = base();
    t.video[1] = { id: 'c1', src: 'card', in: 2, dur: 60 }; // only 2 frames before the card's in
    const p = project(t);
    const { report, proposals } = proposeJoins(p, { rules: [{ from: 'footage', to: 'card', dissolve: 12 }] });
    expect(report.policy).toBe('given');
    expect(proposals.map((x) => [x.after, x.proposed, x.feasible])).toEqual([['f1', 12, false], ['c1', 12, true]]); // c1: card→footage via the reverse rule
    expect(proposals[0]!.reason).toMatch(/at most 5/);
  });

  it('ruleFor prefers an exact rule over wildcards and a named direction over the reverse', () => {
    const rules = [{ from: '*', to: '*', dissolve: 1 }, { from: 'card', to: '*', dissolve: 2 }, { from: 'card', to: 'logo', dissolve: 3 }, { from: 'logo', to: 'card', dissolve: 4 }];
    expect(ruleFor(rules, 'card', 'logo')?.rule.dissolve).toBe(3);
    expect(ruleFor(rules, 'logo', 'card')?.rule.dissolve).toBe(4);
    expect(ruleFor(rules, 'card', 'footage')?.rule.dissolve).toBe(2);
    expect(ruleFor(rules, 'footage', 'card')).toEqual({ rule: rules[1], reversed: true });
    expect(ruleFor(rules, 'footage', 'footage')?.rule.dissolve).toBe(1);
  });
});
