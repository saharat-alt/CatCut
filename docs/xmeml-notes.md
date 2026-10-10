# xmeml (FCP7 XML) notes

Writer and reader: `src/io/xmeml.ts`. Tests: `test/io/xmeml.test.ts`.

## Track layout written by `writeXmeml`

| xmeml tracks | content | `MZ.TrackName` |
|---|---|---|
| V1 | the cut (one video track) | — |
| A1 / A2 | clip audio of V1 clips, linked to the video clipitem | `Clip Audio` |
| A3 / A4 | vo | `VO` |
| A5 / A6 | music | `Music` |
| A7 / A8 | sfx | `SFX` |
| A9+ (pairs) | overflow lanes when clips of one role overlap | `VO 2`, `Music 2`, `SFX 2`… |

The vo/music/sfx pairs are always written (empty when unused) so positions stay fixed.

## Stereo: written the way Premiere exports it

Premiere's "Final Cut Pro XML" export represents a stereo track as two *exploded* xmeml tracks:

- track attributes `currentExplodedTrackIndex="0|1" totalExplodedTrackCount="2" premiereTrackType="Stereo"`,
  plus `<outputchannelindex>1|2</outputchannelindex>`;
- one clipitem per channel (`premiereChannelType="stereo"`): left with `<sourcetrack><trackindex>1`,
  right with `<trackindex>2`, same file / start / end / in / out;
- each clipitem carries a `<link>` to both channel clipitems (and to the video clipitem for clip audio),
  `clipindex` = position among the clipitems of that track.

We write every audio lane (clip audio and vo/music/sfx) like that. A **mono** source still gets both
clipitems, each reading source channel 1, so Premiere rebuilds a centred stereo clip instead of a
left-only one (the old single-clipitem, `sourcetrack 1`, unmarked-track output could import as
left channel only). Choice made over `outputchannelindex`-only marking because it is exactly Premiere's
own export shape, which its importer re-assembles into stereo tracks.

`MZ.TrackName` is our addition for role round-trips; whether Premiere preserves it is unverified, so the
reader never depends on it.

## Reader: roles and stereo pairs

1. **Pairs merge**: audio clipitems that are linked only to each other (no video link), with the same file
   and the same start/end/in/out, become one `AudioClip` (the clipitem on the lowest track is kept).
   Linked clips that differ are kept separately with a warning.
2. **Role of a track**: a recognisable track name (`MZ.TrackName` or `<name>`: VO/voice/narration/พากย์,
   music/เพลง, SFX/FX/effects) wins. Otherwise the position:
   - with exploded-track attributes (our output, Premiere exports): logical stereo/mono tracks
     1 = clip audio, 2 = vo, 3 = music, 4 = sfx; a later unnamed logical track is read as sfx with an
     *ambiguous* warning. A following track without exploded attributes counts as the missing side of a pair.
   - without them (legacy files from older EDITMCP builds): A1/A2 clip audio, A3 vo, A4 music, A5 sfx,
     A6+ sfx with a warning.
   - a merged pair whose two tracks resolve to different roles takes the first track's role and warns.
3. Clip audio linked to a video clipitem is implied by the video and not imported as an audio clip.

## Paths

`pathurl` is written in Premiere's own form: `file://localhost/D%3a/…` (every segment percent-encoded
UTF-8, so Thai names survive); UNC as `file://server/share/…`. The reader accepts both that and
`file:///D:/…`.

## Transitions

Video: `Cross Dissolve` (effectid `Cross Dissolve`). Audio cross fades on clip audio:
name `Cross Fade (+3dB)`, effectid `KGAudioTransCrossFade3dB`. Dissolve N at cut C covers [C−a, C+b),
a = floor(N/2); touching clip edges are written as −1.

## Speed (Clip.speed) and push-in (Clip.pushIn)

- **Constant speed** → a `Time Remap` filter (effectid `timeremap`, category/type `motion`) with
  `variablespeed` 0, `speed` = rate × 100 (4 decimals), `reverse` FALSE, `frameblending` TRUE unless the
  clip's effective interpolation is `nearest`. The clipitem's `in`/`out` (and `<duration>`) are in the
  clip's **retimed** frame space: `in` = round(source in / rate), so `out − in == end − start` as for any
  clip; source frames needed = round(retimed frame × rate). The linked clip-audio items carry the same
  filter (mediatype audio) and the same retimed in/out.
- **Ramps** (rampFrom/rampFrames) cannot be expressed as constant speed: the writer uses the average rate
  (source span / dur) and `xmemlExportWarnings(p)` says so. `motion` interpolation is written as frame
  blending (Premiere's Optical Flow has no xmeml field) with a warning too.
- **Push-in** → Basic Motion `scale` with two keyframes: base scale (`Clip.scale`, default 100) at the first
  body frame, base × (1 + pushIn/100) at the last body frame (`when` in the clipitem's in/out space);
  dissolve handles hold the end values, as the Assembler does.
- **Reader**: a `timeremap` filter gives `speed.rate` (and interpolation from `frameblending`). in/out are
  taken as retimed frames when `out − in == end − start`, as source frames when `out − in ≈ (end − start) ×
  rate` (some exporters), otherwise retimed with a warning. Variable speed and reverse are read as the
  constant forward `speed` value with a warning. Animated scale is read back as a push-in: the zoom rate
  between the first and last keyframe extended over the clip body — exact for our own output, an
  approximation (warning) for hand-moved or extra keyframes; a pull-out keeps only the first value.
- **Round trip against the project**: when a clip with the same id and asset exists in the project and the
  XML speed equals what we would write for it, the project's exact speed object (ramp, interpolation) and
  in-point are kept (rate 2 with an odd in-point would otherwise come back ±1 frame); the ramp keep is
  reported as a warning.

## Still unverified in Premiere 2026

Odd dissolve lengths, Motion scale, Thai `pathurl`, whether `MZ.TrackName` survives a round trip, and the
speed representation: whether Premiere's importer expects retimed or source in/out on speed-changed clips,
and whether it needs the Time Remap filter on the linked audio items.
