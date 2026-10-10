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

## Still unverified in Premiere 2026

Odd dissolve lengths, Motion scale, Thai `pathurl`, and whether `MZ.TrackName` survives a round trip.
