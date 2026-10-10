# EDITMCP — project conventions

Headless video-editing MCP: After Effects (no UI) + aerender + ffmpeg assembly, FCP7 XML for Premiere.
Design doc: `docs/DESIGN.md` (read the section you work on). TypeScript, ESM, Node ≥ 22, Windows-first.

## Hard rules
- **Frames, never seconds**, in all models and math. Project fps lives in `project.meta.fps` (default 25).
- **Never overwrite** an existing output. Renders, masters, deliverables get a new versioned path. Overwriting is a bug.
- **Never run After Effects / aerender from tests or module code during this build** unless explicitly told; another session may be using AE. AE code must be unit-tested with mocked process spawns. ffmpeg/ffprobe may be run freely on small synthetic media (`testsrc`, `sine`) written under `tmp/` or the OS temp dir.
- **Never touch** `D:\261009_STB50Y_THAI-WORLD_CSR` (a live production job).
- **Thai / non-ASCII paths**: AE render outputs go to an ASCII temp path, then are renamed. ffmpeg gets paths only as `-i` arguments or via UTF-8 list/graph files, never inside filter strings. Everything written to disk is UTF-8.
- **ProRes master is stitched, not re-encoded**: segments are ProRes 422 HQ MOV (video-only, all-intra); the master video is `concat -c copy` of segments. Any re-encode of an unchanged segment is a bug.
- Audio is rendered whole each build (cheap), then muxed.
- Dissolve of N frames at cut C: a = floor(N/2) before, b = N − a after; covers [C−a, C+b); total length unchanged.
- Processes: always spawn with timeouts and kill the whole tree on timeout. Never `shell: true` with user paths.
- Memory-aware: check free RAM before launching aerender/AE; default one AE render at a time.

## Layout
```
src/core      types.ts (the contract everyone codes against), project.ts, timecode.ts, tools.ts, hash.ts, jobs.ts
src/engine    ffmpeg.ts (probe/segments/concat/audio/mux), presets.ts (delivery targets), qc.ts, ae.ts (AeBackend), aerender.ts
src/io        xmeml.ts (write + read)
src/mcp       server.ts (tools), cli.ts (doctor/build)
jsx/          runner.jsx + command scripts for AfterFX -m -noui
test/         vitest; synthetic media only
```
- Tool paths come from `src/core/tools.ts` (`discoverTools()`), never hardcoded elsewhere.
- Keep modules independent: import from `../core/types.js` and `../core/*`, not from sibling engines, unless the contract says so.
- Tests: `npm test` (vitest). Build: `npm run build` (tsc). Lint-level cleanliness: no unused exports, no `any` leaks in public signatures.
- Comments: brief, only where the why is non-obvious. Thai is fine in user-facing strings.
