# jsx/ — headless After Effects bridge

`runner.jsx` is the only ExtendScript the MCP runs. It is ES3, has no dependencies, and is driven
entirely by a UTF-8 JSON job file. `src/engine/ae.ts` is its only caller; renders do not go through
it. They use `aerender.exe` (`src/engine/aerender.ts`).

## Bridge protocol

1. `ae.ts` creates an ASCII temp dir `%TEMP%\editmcp-ae-XXXX\` containing:
   - `job.json`: `{ action, aep, comp?, comps?, atFrame?, ops?, result }`, UTF-8. U+2028/2029 are escaped
     so the JSON is also valid ES3 source.
   - `launch.jsx`: two generated lines, `var EDITMCP_JOB = "<job path>"; $.evalFile(runner.jsx)`.
     User values (Thai paths, comp names, text) never go into JSX source. They only travel in the JSON.
2. It spawns `AfterFX.com -m -noui -r launch.jsx` without a shell. A timeout kills the whole process tree.
3. The runner opens the project, does the action, writes `{ ok, data, log, error }` to `job.result`, closes
   the project without saving and calls `app.quit()`. If the job file itself cannot be read, the result is
   written to `<job path minus .json>.result.json` (`job.result.json`), which is the path `ae.ts` already
   reads. Closing the project and ending dialog suppression are each wrapped in try/catch, so `app.quit()`
   always runs.
4. `ae.ts` reads the result and removes the temp dir. One Adobe process runs at a time (`serial()`), and
   that includes aerender renders.

Actions: `version`, `list` (CompInfo[] + `displayStartFrame`), `inspect` (layers + snapshot), `fingerprint`
(snapshot per comp), and `edit`. `edit` runs on a **copy** of the .aep (`.editmcp-<uuid>.aep`), never on
the user's file.

Timeouts (`createAeBackend` options): `timeoutMs` applies to `list`/`version` (default 2 min).
`fingerprintTimeoutMs` applies to `fingerprint`/`inspect`/`edit`, which walk whole comps (default 10 min,
because large projects take that long to open and snapshot).

## Invocation: `-m -noui`

- `-m` starts a **new** instance. Without it, `AfterFX.exe -r` hands the script to an already-running GUI.
  That GUI would then be driven, or blocked, by our job.
- `-noui` means no windows. Some calls are not available in that mode (see below).
- `app.beginSuppressDialogs()` is set and `saveProjectOnCrash` is turned off, so a modal dialog cannot
  hang an unattended run. The process timeout is the backstop.

## In-place edits and a running GUI

`ae_edit` without `saveAs` puts the edited copy in place of the user's .aep. It keeps a
`<name>_backup_<ts>.aep` first and re-hashes the source just before the rename. If an After Effects GUI
already has that project open, the GUI still holds the old version in memory, and its next **save silently
reverts the edit**. Before replacing the file, `ae.ts` runs `tasklist /V` to look for `AfterFX.exe` windows.
If it finds one, the result gets `aeGuiRunning: true`, a `warning`, and a `WARNING:` log line. Headless
instances have no window title (`N/A`) and are ignored. **`saveAs` is the safe option** when AE might be
open: it writes a new .aep and leaves the original untouched.

## Renders: always an explicit frame range

aerender with no `-s/-e` uses the time span of the render-settings template, which is often
"Work Area Only". That renders a different length without any error. `ae.ts` therefore always passes
`-s <displayStartFrame + 0> -e <displayStartFrame + durationFrames - 1>`. aerender's frame numbers count
from the comp's display start (Start Timecode/Start Frame), so 0-based comp frames are offset by
`displayStartFrame`. `previewFrame` uses the same offset. The rendered frame count is checked against the
comp duration from the runner, never against aerender's own `Duration:` line. Comp timing is cached from
the last list/fingerprint/inspect job while the .aep hash is unchanged. Builds pass `-mfr ON <n>`
(90 by default, lowered when free RAM is low).

The ProRes template fallback (`Lossless` → ffmpeg ProRes 422 HQ, BT.709-tagged) happens only when one of
aerender's own `ERROR` lines says the output-module template was not found. It never happens on timeout or
abort, and never because a comp or project name contains a word like "missing".

## Known AE 25/26 pitfalls

| Pitfall | Workaround here |
|---|---|
| Non-ASCII output file names set from scripts or the CLI are mangled (25.2–26.x) | Render to an ASCII temp name (`aer_<rand>_<stem>`), then rename to the Thai path. Partial temp files are deleted when a render fails, times out or is aborted |
| `CompItem.saveFrameToPng` is asynchronous, and under `-noui` it often never writes | `aerender -s N -e N` with the Lossless template, then ffmpeg → PNG |
| `app.executeCommand` (menu commands) is unavailable or does nothing headless | Not used. Features that need UI are done in the GUI, and the fingerprint picks up the change |
| `app.newProject()` crashed under `-noui` on 26.5 (observed) | The runner only opens existing projects. `tests/adobe_smoke.mjs` tries `-m -noui -r` first and falls back to `-m -r` (a visible window may appear) only to create its fixture |
| "Allow Scripts to Write Files and Access Network" is off by default | The runner cannot write its result without it. Enable it once in Preferences > Scripting & Expressions. Otherwise every job fails with "cannot write …" |
| Duplicate comp names | Refused with "ambiguous comp name" instead of AE picking one silently |

## Fingerprint tradeoffs

A comp's fingerprint is a hash of the runner snapshot plus every referenced media file (size + mtime +
head/tail bytes; all frames of an image sequence; proxies). The snapshot covers the layer tree, keyframes,
values, text documents, comp settings (including `workAreaStart`, `workAreaDuration` and
`displayStartFrame`) and project color settings. **The .aep file itself is not hashed**, so re-saving or
merely opening and saving the project does not re-render anything.

- **Expressions**: the snapshot records the expression text, `expressionError`, and the **evaluated value**
  at comp start, comp end, 8 evenly spaced frames and every keyframe time (at most 64 samples). A change
  to whatever the expression reads, such as another comp, a control layer or a data file, is caught when
  it changes the result at one of those frames. A change that only shows between sampled frames is missed.
  Comps with expressions also hash every footage file in the project, so expression-read data files are covered.
- **Per-character text styles**: these are read through `TextDocument.characterRange` (AE 24.3+). On older
  versions only the document-level fields are hashed, and the comp is marked opaque.
- **Opaque values** (`PropertyValueType.CUSTOM_VALUE`, for example Curves and Levels histograms): scripting
  cannot read these. What is hashed instead is the effect's matchName, all of its readable sibling
  properties, and the rest of the layer state. The comp is reported with `opaque: true`
  (`fingerprintDetailed()`). A change made **only** inside such a value (dragging a Curves point, say) is
  not detected. The MCP should tell the user that such edits may need a forced re-render.

The alternative, re-rendering any comp like that whenever the .aep changes, made almost every real comp
re-render on every save. That is why these signals are scoped as described above.
