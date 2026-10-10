# EDITMCP

**EDITMCP** คือ MCP server สำหรับตัดต่อวิดีโอแบบ headless: แก้ comp ใน After Effects โดยไม่เปิดหน้าโปรแกรม (`AfterFX -m -noui`), render ด้วย `aerender`, แล้วให้ `ffmpeg` ประกอบเป็น master ProRes 422 HQ จาก "ท่อน" ที่ cache ไว้ — แก้จุดเดียว render ใหม่แค่จุดนั้น ส่วนที่ไม่เปลี่ยนไม่ถูก encode ซ้ำ จึง export เร็วและคุณภาพเท่า export ตรงจาก AE จากนั้นทำ QC (เฟรม, ภาพดำ/ค้าง, เสียงเงียบ, loudness), สร้าง deliverable ตาม preset (YouTube, Facebook, แนวตั้ง, XDCAM HD422 ออกอากาศ, ProRes) และส่งออก/รับกลับ FCP7 XML เพื่อไปขยับไทม์มิ่งเองใน Premiere ได้ ใช้ได้ทั้งกับ Claude Code และ Codex ทุกค่าเวลาเป็น **เฟรม** ไม่ใช่วินาที และ**ไม่เขียนทับไฟล์เดิม**เด็ดขาด (ทุก build ได้เวอร์ชันใหม่)

## ติดตั้ง / Install

ต้องมี Node ≥ 22, ffmpeg/ffprobe (winget `Gyan.FFmpeg` หรือกำหนด `EDITMCP_FFMPEG=<bin folder>`) และ After Effects (ถ้าจะใช้ `ae_*`)

```bash
npm i
npm run build                  # → dist/
node dist/mcp/cli.js doctor    # ตรวจว่าเจอ ffmpeg, encoders (NVENC), AE, RAM
```

ระหว่างพัฒนาใช้ `npm run doctor` (= `tsx src/mcp/cli.ts doctor`) ได้โดยไม่ต้อง build

## ตั้งค่ากับ Claude Code

`.mcp.json` ในโฟลเดอร์งาน (หรือ `~/.claude.json` สำหรับทุกโปรเจกต์):

```json
{
  "mcpServers": {
    "editmcp": {
      "command": "node",
      "args": ["D:/EDITMCP/dist/mcp/cli.js", "serve"]
    }
  }
}
```

## ตั้งค่ากับ Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.editmcp]
command = "node"
args = ["D:/EDITMCP/dist/mcp/cli.js", "serve"]
```

ใส่ `"D:/path/to/project"` ต่อท้าย `serve` ได้ถ้าอยากให้เปิดโปรเจกต์ทันที (ไม่งั้นเรียก `project_open` ทีหลัง)

## เริ่มใช้ / Quick start

ทุกเครื่องมือรับ JSON และตอบ JSON; งานหนัก (`build`, `deliver`) คืน **job id ทันที** แล้วดูความคืบหน้าด้วย `job_status`

```text
doctor                                     → ffmpeg / NVENC / AE / RAM + ข้อควรระวังตามเวอร์ชัน
project_new   {dir, name, fps: 25}          → สร้าง project.json (1920x1080 โดยปริยาย)
asset_add     {path: "D:/footage/คลิป01.mp4", id: "A01"}
asset_add     {aep: "D:/ae/titles.aep", comp: "Title_01", id: "C_title"}
timeline_set  {timeline: {
                 video: [{id:"s1", src:"C_title", in:0, dur:125, marker:"เปิดเรื่อง"},
                         {id:"s2", src:"A01",     in:312, dur:88}],
                 cuts:  [{after:"s1", dissolve:10}],
                 audio: {vo:[], music:[{id:"m1", src:"M01", at:0}], sfx:[],
                         duck:{underDb:-12, attackMs:150, releaseMs:400}}}}
timeline_edit {ops: [{op:"trim", id:"s2", dur:100}, {op:"set_dissolve", after:"s1", frames:12}]}
audio_add     {track:"vo", src:"VO01", at:0}
build         {}                            → {jobId:"job-0001"}  … job_status {id:"job-0001"}
qc_report     {}                            → เฟรมครบไหม, ภาพดำ/ค้าง, loudness
deliver       {targets:["yt","th_tv"]}      → job → out/v001/<name>_v001_yt.mp4, …
export_premiere_xml {}                      → out/v001/<name>.xml
```

`build` ทำงานแบบ incremental: comp ที่ fingerprint เปลี่ยนเท่านั้นที่ถูก render ใหม่, ท่อนที่เคยทำแล้วถูกใช้ซ้ำจาก cache, master ต่อด้วย `concat -c copy` (ไม่ encode ซ้ำ), เสียงทำใหม่ทั้งเรื่อง (เร็ว) แล้ว mux — build ซ้ำโดยไม่แก้อะไรจะ render 0 ท่อน

Preset deliverable: `yt`, `fb`, `vert` (1080x1920 ครอปกลาง), `th_tv` (XDCAM HD422 MXF 1080i50, -24 LKFS), `th_prores`, `led` (H.264 50 Mbps CBR), `m422hq` (ProRes master -23 LUFS)

## รอบแก้มือใน Premiere / Premiere round-trip

1. `export_premiere_xml` → ได้ `out/<version>/<name>.xml` (xmeml v5) ที่ลิงก์ไป **render เต็ม comp** และไฟล์กล้องต้นฉบับ ไม่ใช่ Dynamic Link
2. ใน Premiere: File > Import ไฟล์ XML → ขยับ / slip / trim / เปลี่ยนความยาว dissolve / marker / scale ได้ตามใจ
3. File > Export > **Final Cut Pro XML** → บันทึกเป็นไฟล์ใหม่
4. `import_premiere_xml {path}` → ได้สรุปความต่าง (คลิปไหนเปลี่ยน in/dur, dissolve ไหนเปลี่ยน) และใช้กับไทม์ไลน์ทันทีถ้าผ่านการตรวจสอบ (ไฟล์ที่จับคู่กับ asset ไม่ได้จะอยู่ใน `unresolvedPaths` — เพิ่มด้วย `asset_add` แล้ว import ใหม่)
5. `build` → render เฉพาะ dissolve/ท่อนที่กระทบ → เวอร์ชันใหม่ในไม่กี่วินาที–นาที

สิ่งที่กลับมาได้: trim, slip, ลำดับ, dissolve, marker, scale — เอฟเฟกต์เฉพาะ Premiere (Lumetri, Warp Stabilizer) ไม่กลับมา ให้ทำใน AE แทน

## CLI

```bash
editmcp doctor
editmcp serve [projectDir]
editmcp build D:/jobs/csr --force          # --skip-qc --skip-deliver
editmcp deliver D:/jobs/csr v001 yt th_tv
editmcp xml-export D:/jobs/csr --version v001
editmcp xml-import D:/jobs/csr D:/jobs/csr/from_premiere.xml
```

`doctor` ไม่เปิด After Effects (รายงาน `AE version: unknown (not launched)`) เว้นแต่ตั้ง `EDITMCP_ALLOW_AE=1`

## โครงสร้างโปรเจกต์

```text
<project>/project.json        ความจริงเดียว: assets, timeline (เฟรม), delivery, versions
<project>/cache/renders/      render เต็ม comp (ProRes)      cache/segments/  ท่อนภาพ + manifest.json
<project>/out/v001/           master .mov, deliverables, .xml   review/        proxy, contact sheet
```

## พัฒนา

```bash
npm test                      # vitest (สื่อสังเคราะห์เท่านั้น ไม่เปิด AE)
npm run typecheck
npm run build
node tests/stdio_smoke.mjs     # ทดสอบ MCP stdio ของ CLI ที่ build แล้ว (ไม่เปิด AE)
```

กฎของโปรเจกต์อยู่ใน `CLAUDE.md`, แบบดีไซน์ใน `docs/DESIGN.md`

ผลตรวจล่าสุดและข้อจำกัดอยู่ใน [`docs/STATUS.md`](docs/STATUS.md): แกนระบบผ่านการทดสอบด้วย ffmpeg จริง; AE ใช้ mocked process/host และยังต้องตรวจใน Adobe จริงก่อนใช้กับงานผลิต

`ae_edit` แก้สำเนาชั่วคราวก่อน แล้วบันทึกกลับต้นฉบับพร้อมเก็บ `<name>_backup_<timestamp>.aep`; ถ้าใช้ `saveAs` จะสร้างไฟล์ใหม่และปฏิเสธชื่อที่มีอยู่แล้ว งาน build/deliver จะล็อกคำสั่งแก้โปรเจกต์ของ server นั้นจนจบ ควรใช้ server/CLI เพียงตัวเดียวต่อโฟลเดอร์โปรเจกต์

ไฟล์ที่ fps ต่างจากโปรเจกต์ใช้ตำแหน่งและความยาวเป็นเฟรมของโปรเจกต์เสมอ การ encode ท่อนใหม่จะ decode ตั้งแต่ต้นไฟล์เพื่อคง sampling grid ให้ถูกต้อง จึงอาจช้าเมื่อ in-point อยู่ลึกในฟุตเทจยาว; build ที่ไม่เปลี่ยนภาพจะใช้ cache ตามเดิม

AE fingerprint ติดตาม property/keyframe/expression, precomp, proxy และ image sequence; comp ที่มี expression หรือค่า plugin ที่อ่านไม่ได้จะติดตามไฟล์ `.aep` ทั้งไฟล์แบบ conservative จึงอาจ render ใหม่มากกว่าหนึ่ง comp เมื่อแก้โปรเจกต์
