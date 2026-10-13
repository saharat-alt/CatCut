# CatCut (EDITMCP) implementation status

## อัปเดต 2026-10-13: แก้ sequence เดิมใน Premiere (CATCUT_FEATURE_REQUEST.md จากงาน Thai Agri)

- อ่าน: `premiere_timeline_get` (ทุกคลิปทุกแทร็กเป็นเฟรม), `premiere_clip_effects` (พารามิเตอร์ คีย์เฟรม สี)
- แก้: `premiere_edit {ops[]}` remove (+ เสียงที่ลิงก์), trim, move, set_speed, overwrite (ไฟล์/AE comp, ลบเสียงเปล่า), replace_media, relink, rename, set_motion, add/remove_effect, set_effect_param — ระบุคลิปด้วย track+start+end(+name) ถ้าไม่ตรงไม่แก้; dry run เป็นค่าเริ่มต้น; apply = Save จุดย้อนกลับ + สำเนา .prproj ที่ `%LOCALAPPDATA%\CatCut\premiere-backups` → แก้ → ตรวจ signature คลิปอื่น; Save ผลเมื่อ `save: true`; `premiere_undo_last`
- `premiere_place_ae_comp`, `premiere_frames`, `premiere_export_range` (ค่าเริ่มต้น preset "Match Source - Adaptive High Bitrate" ของ Premiere), `ae_live_run` (เฉพาะเมื่อผู้ใช้สั่ง, ผ่าน BridgeTalk)
- bridge 0.3.0: คิวย้ายไป `%LOCALAPPDATA%\CatCut\bridge` (สร้างใหม่เองถ้าถูกลบ), ยังคุยกับ bridge เก่าใน TEMP ได้; bridge เก่าไม่บล็อก — คำสั่งที่ไม่มีตอบการ์ดอัปเดต; `host.user.jsx` สำหรับคำสั่งเฉพาะงาน (โหลดใหม่เองเมื่อแก้, อยู่รอดหลังติดตั้งทับ); ติดตั้งทับจะสำรอง bridge เดิมไว้ที่ `%LOCALAPPDATA%\CatCut\bridge-backups`; timeout ตั้งได้ (`timeoutSec`)
- `ready_check` แสดงขนาด AE Disk Cache (ระหว่างงานนี้ C: เต็มจาก `Temp\Adobe` ~30 GB)
- `npm test`: 34 files ผ่าน (1 skipped) — ทุกอย่างทดสอบกับ Premiere จำลอง; **ยังไม่ได้ลองกับ Premiere จริง**: `closeDocument`, `importAEComps`, `TrackItem.move`, การตั้ง `start/end/inPoint`, QE `addVideoEffect`/`getComponentAt().remove()`, `exportFramePNG`, `exportAsMediaDirect`, BridgeTalk

## อัปเดต 2026-10-12: ง่ายขึ้น ไม่ต้องเปิดโปรแกรมค้าง (DESIGN ข้อ 14, จากงาน Thai Agri Foods reshoot)

- `ready_check` / `catcut ready`: การ์ดต่อโปรแกรม (ffmpeg, After Effects, Premiere + bridge, ดิสก์) ตรวจโดยไม่เปิด Adobe — ทดลองบนเครื่องนี้แล้ว: เจอ AE 26.5 พร้อม, bridge ที่ติดตั้งเป็นรุ่นเก่า (ของ Codex), C: เหลือน้อย
- User Action Card (`userAction` ใน error): ทำอะไร · ทำไม · ครั้งเดียว/ทุกครั้ง · ต้องเปิดค้างไหม · ปิดได้เมื่อไร; AE: Allow Scripts / Sign in ครั้งเดียว / ไม่พบ AE; Premiere: ยังไม่ติดตั้ง, ต้องอัปเดต, ต้องปิด–เปิดครั้งเดียว, bridge ไม่เริ่มเอง, มีหน้าต่างค้าง, เปิดช้า
- bridge 0.2.0: heartbeat เดินต่อระหว่าง Premiere ทำงาน (`busy`), โหลด host.jsx ใหม่เองเมื่อไฟล์เปลี่ยน, เขียน heartbeat ทนการอ่านพร้อมกันบน Windows, ปิด Premiere หลังตอบผลแล้วเท่านั้น
- ใหม่: `premiere_open` (เปิด Premiere + โปรเจกต์ให้เอง), `premiere_save`, `premiere_close`, `premiere_import_media` (ต้นฉบับชื่อเดิม bin ตามการ์ด แนบ `_Proxy`), `premiere_set_speed` (native + Optical Flow), `proxy_make`; `timeline_lint` `slowmo`; `board_vs_cut` เช็กชื่อไฟล์ที่บอร์ดระบุ; `disk_report` แยกโฟลเดอร์อื่น + งบ 50 GB
- `npm test`: 33 files / 403 tests ผ่าน (1 skipped: EffectCraft จริง); `tests/stdio_smoke.mjs` ผ่าน (แก้ assertion เดิมที่ค้างจากตอนเปลี่ยน import XML เป็น dry run)
- **ยังไม่ได้ลองกับ Premiere/AE จริง**: เปิด Premiere จาก command line + auto-start, `app.openDocument`, `app.quit`, QE `setSpeed`/`setTimeInterpolationType(2)` (Codex ใช้ได้จริงในงานนั้น), hot reload `$.evalFile`; ข้อความ error ของ AE ตอนยังไม่ Sign in
- bridge ที่ติดตั้งอยู่ในเครื่องตอนนี้เป็นฉบับที่ Codex แก้ (มีคำสั่งเฉพาะงาน reshoot) — `catcut premiere-bridge install` จะแทนที่ฉบับนั้น

## อัปเดต 2026-10-11 (รอบ 2): แก้ตามรีวิว + บทเรียนงาน CSR (DESIGN ข้อ 13)

- ชื่อแอป **CatCut** 🐾 (โลโก้ `assets/brand/catcut-logo.svg`; CLI `catcut` และ alias `editmcp`; env `EDITMCP_*` ยังใช้ได้)
- หลักสูงสุด: **โจทย์/บรีฟเป็นตัวตัดสิน** — lint/สแกนทั้งหมดเป็น advisory, กฎเก็บต่อโปรเจกต์พร้อมที่มา, บรีฟชนะคำสั่งทั่วไป
- ใหม่: `board_import/set/check/link`, `board_vs_cut` (HTML), `fit_duration` · `shots_detect`, `timeline_lint` (flash/cutcross/repeat/lowmotion), `timeline_snap`, `scan_footage` (mojibake/pillarbox/VFR) · `template_scan`, `comp_lint` (แอนิเมชันจบก่อน, พื้นหลังหมด, Thai animator), `font_audit`, `ae_purge_cache` · `rules_*` (constraints/styleRules/evidence), `disk_report`, `cache_gc_plan/apply` (ต้องยืนยัน), `version_keep` · speed/ramp/pushIn, `joins_report/apply`, `shot_revert`, `preview_range` · หน้ารีวิว redesign แนว Apple + Linear: ปากกาสี = ประเภทการแก้, โน้ตพักไว้, A/B + wipe, ก่อน/หลัง, `review_compare_sheet`
- build: เช็กดิสก์ก่อน (error < 5 GB, warn < 20 GB), ล้าง cache AE หลัง render เมื่อดิสก์ต่ำ
- `npm test`: 28 files ผ่านทั้งหมด (ดูผลล่าสุดใน commit); AE/Premiere ยังไม่ได้ทดสอบจริงกับฟีเจอร์รอบนี้ — ดูรายการ "ต้องตรวจกับ AE จริง" ใน `jsx/README.md` และ `docs/xmeml-notes.md`

---

ตรวจวันที่ 11 ตุลาคม 2026 เวลาไทย บน branch `codex/finish-editmcp` จาก scaffold `ffd2d09` โดยรับไฟล์ที่ Claude เขียนค้างไว้มารวมและทำต่อ

## ผลที่ตรวจแล้ว

- `npm test`: 123 tests ผ่านทั้งหมดใน 14 files; ไม่มี skipped tests
- `npm run build`: ผ่าน TypeScript compiler; มี CLI และ server ใน `dist/`
- `npm run typecheck`: ผ่าน
- `node tests/stdio_smoke.mjs`: ผ่าน MCP stdio ของ CLI ที่ compile แล้วจริง ตั้งแต่ doctor → project/asset/timeline → build สองครั้ง → QC → export/import XML
- `node dist/mcp/cli.js doctor`: พบ ffmpeg/ffprobe 9.0.1 และ Adobe 2026; ไม่เปิด Adobe เพื่ออ่านเวอร์ชัน
- `npm audit --omit=dev`: ไม่พบช่องโหว่ใน production dependencies ณ เวลาตรวจ

## หน้ารีวิวในเครื่อง (ทำต่อหลัง core)

- `preview`, `review_open`, `review_notes`, `review_submit`, `review_close` ใช้งานผ่าน MCP; CLI `editmcp review <projectDir> [--version v001]` แสดง URL และรอจนปิด server
- เครื่องเล่น H.264, เดินเฟรม, J/K/L, เลือกช็อตและช่วง I/O, เส้นวงแบบ normalized, intent/โน้ตไทย, เพิ่ม/แก้/ลบ/ทำเครื่องหมายแก้แล้ว และส่งรีวิว
- เก็บ shot/source/comp snapshot ต่อ build พร้อม transition context; เวอร์ชันเก่าไม่อ้างไทม์ไลน์ใหม่ผิดชุด และ preview ใช้ format ของเวอร์ชันนั้น
- Session autosave แบบ atomic, revision conflicts, lock ข้ามโปรเซส และสำเนาใหม่ทุก submission; ไม่ใช้โน้ตสั่งแก้งานเอง
- HTTP เปิดเฉพาะ loopback ใช้ session URL แบบสุ่ม, ตรวจ Host/Origin, จำกัดขนาด JSON, validate frames/regions, CSP และเสิร์ฟเฉพาะไฟล์ของเวอร์ชัน
- ทดสอบใน Chrome และ Codex browser ด้วยสื่อสังเคราะห์: seek ตรงเฟรม, เลือกช่วง, วง/เพิ่มโน้ต, submit, reload แล้วเปิดโน้ตกลับ; ไม่พบ console error และไม่มี horizontal overflow ที่ 320/768/1024/1440 px
- Regression tests เพิ่มเรื่องเขียนจาก 4 โปรเซส, submit ระหว่าง autosave, วาดก่อน seek เสร็จ และการคง snapshot หลังแก้ไทม์ไลน์; compiled stdio smoke ทดสอบ review proxy → HTTP → notes → submit → close ด้วย
- UI ใช้ Noto Sans Thai ในเครื่อง ธีมมืดทั้ง viewer/แผงโน้ต/ช่องกรอก ตัวหนังสือโน้ตและช่องกรอก 16 px พร้อมเพิ่ม contrast ของ label; ตรวจ responsive 320/768/1024/1440 px อีกครั้ง และเปิด proxy ที่เรนเดอร์จาก AE จริง
- ข้อจำกัด: เวอร์ชันเก่าที่ไม่มี snapshot และ planHash ไม่ตรงต้อง rebuild; crash กลาง transaction อาจค้าง `session.lock` ต้องปิดทุก review process แล้วลบ lock ก่อน retry; ยังไม่มี AE layer hit-test, voice note หรือ before/after comparison และ dissolve ใช้ nominal shot mapping

## สิ่งที่ทำครบใน core

Project persistence, assets, frame-based timeline edits/validation, content hashes, background jobs/cancellation, AE backend + ES3 JSX runner, aerender queue, ProRes segment/dissolve cache, concat ด้วย stream copy, audio mix/VO ducking/loudness, master mux/QC, delivery presets, review proxy, FCP7 XML writer/reader, MCP tools และ CLI

แก้ข้อผิดพลาดที่พบระหว่างรวม: readonly execa options, marker expectation ใน fixture, ระยะเวลาฟุตเทจต่าง fps, sampling grid ตอน trim, cache ไม่รู้เมื่อฟุตเทจเปลี่ยน/เสียหาย, สัญญาณยกเลิก QC/delivery/fallback, การแก้ไทม์ไลน์กลาง build, loudness cache ข้าม target, การ publish output ที่อาจเขียนทับกัน, option interlace เก่าบน ffmpeg 9 และ runtime GPU fallback

`ae_edit` ใช้ working copy ในโฟลเดอร์เดียวกับต้นฉบับ สำรองต้นฉบับก่อนบันทึก และปฏิเสธ commit ถ้าต้นฉบับเปลี่ยนระหว่างทำงาน; `saveAs` และ output ใช้การสร้างไฟล์แบบ exclusive

## การทดลอง incremental

สื่อสังเคราะห์ 320×180, 25fps, 5 คลิป รวม 200 เฟรม (8 วินาที), dissolve 10/13/10 เฟรม, still, path ไทย/เครื่องหมาย quote, ProRes ต้นฉบับ, VO + music ducking และ comp จำลอง 1 ตัว

| Build | Comp render | Body render / reuse | Dissolve render | เวลารวม |
|---|---:|---:|---:|---:|
| ครั้งแรก | 1 | 5 / 0 | 3 | 1.94 s |
| ไม่แก้อะไร | 0 | 0 / 5 | 0 | 1.02 s |
| เปลี่ยน comp เดียว | 1 | 1 / 4 | 2 | 1.41 s |

ตัวเลขนี้เป็นผลตัวอย่างที่บันทึกไว้ของ fixture เล็กบนเครื่องนี้ มี AE mock และไม่ได้รวมการส่งออกทุก preset; ไม่ใช่ benchmark AE หรือเวลาที่รับประกันกับงาน 1080p จริง รายละเอียดที่สร้างซ้ำได้อยู่ใน `test/engine/ffmpeg.test.ts`; ผลแต่ละรอบเขียนไว้ใน `tmp/e2e-results.json`

ยืนยันเพิ่มว่า master เดิมไม่เปลี่ยน, cache เสียหายถูกสร้างใหม่เฉพาะท่อน, ProRes HQ ที่ตรง format ถูกตัดด้วย stream copy และ mixed-fps trim ให้ decoded frame hashes เหมือน normalize fps ก่อน trim

ทดสอบทั้ง 7 preset (`yt`, `fb`, `vert`, `th_tv`, `th_prores`, `led`, `m422hq`) ด้วย fixture 1 วินาที ตรวจ codec, dimensions, frame count, audio format และ decode ได้ครบ; MXF ตรวจ top-field-first (`tt`) ด้วย ffprobe ใช้ CPU ในการทดสอบทุก preset และใช้ mocked GPU failure เพื่อทดสอบ fallback

## ทดสอบ After Effects จริงตามที่ผู้ใช้อนุญาต

`tests/adobe_smoke.mjs` ผ่านกับ AE `26.5x89` บนเครื่องนี้ โดยสร้าง fixture ใหม่แยกจากงานผู้ใช้: 2 comps, 640×360, 25fps, master 50 เฟรม (2 วินาที), dissolve 13 เฟรม, ข้อความและ path ไทย ใช้ฟอนต์ Tahoma ใน comp ทดสอบ

- `AfterFX -m -noui`: list/inspect/fingerprint/edit comp ทำงานจริง; `aerender` เรนเดอร์จริงเป็น master ProRes HQ (`apch`) ตรวจครบ 50 เฟรมและ decode ทั้งไฟล์ทั้งสามเวอร์ชัน
- ไม่มี template `EDITMCP ProRes 422 HQ` ในเครื่องนี้ จึงใช้ Lossless → ffmpeg ProRes HQ fallback จริงสำเร็จ
- Build แรก render 2 comps/2 segments; build ไม่แก้ render 0 และ reuse 2; แก้ข้อความไทยหนึ่ง comp แล้ว render 1/reuse 1 ทั้ง comp และ segment โดย hash ของ master เดิมยังเท่าเดิม
- `ae_edit` เก็บ backup `.aep` ที่ hash ตรงต้นฉบับก่อนแก้; single-frame PNG ผ่าน aerender และ path `เฟรมไทย.png` เปิดแล้วเห็นข้อความไทยถูกต้อง
- สร้าง XML และ H.264 review proxy จาก master จริงสำเร็จ; ยังไม่ import XML ใน Premiere เพราะ MCP Bridge ไม่เชื่อมต่อ และผู้ใช้ให้ทำ AE/UI ก่อน
- QC ตรวจ frame count ผ่าน แต่ `qcOk: false` ตาม fixture ที่ตั้งใจให้เป็นภาพนิ่งและไม่มีเสียง: freeze 2 จุด, silence 1 จุด และ loudness ต่ำ 1 จุด ไม่มี black-frame issue; นี่เป็น smoke test ของการเชื่อมต่อ ไม่ใช่งานที่ผ่าน QC เพื่อส่งผลิต
- พบ `newProject()` ล้มเมื่อสร้าง fixture ด้วย `-noui` บน AE เครื่องนี้ จึงสร้าง fixture ด้วยอินสแตนซ์ใหม่ `-m -r` แล้วปิด จากนั้นทดสอบ backend แบบ headless ตามเดิม ไม่เปลี่ยน prefs ของ Adobe

หลักฐานรอบที่ผ่านอยู่ใน `tmp/adobe-test/real-fy6een/report.json` พร้อม logs/probe/QC และ outputs; ทุกครั้งที่รันจะสร้างโฟลเดอร์ใหม่ ไม่เขียนทับหลักฐานเก่า ไม่แตะงาน `D:\261009_STB50Y_THAI-WORLD_CSR`

## ขอบเขตที่ยังไม่ยืนยัน

- AE plugin/expression/footage และฟอนต์ของงานผลิตยังไม่ทดสอบจริง; template ProRes แบบติดตั้งเองยังไม่ทดสอบ เพราะรอบจริงใช้ Lossless fallback
- ต้อง import/export XML ใน Premiere 2026 จริง โดยเฉพาะ odd dissolve, scale, path ไทย และฟุตเทจต่าง fps; reader จำกัด V1 และส่ง warning เมื่อทิ้งสิ่งที่โมเดลไม่รองรับ
- การ decode/probe preset ไม่ใช่การรับรองการ ingest ของสถานีทีวีหรือ color pipeline
- ยังไม่ทดสอบ GPU จริง; inventory ใน doctor หมายถึง encoder ที่ ffmpeg มี ไม่ได้ยืนยัน driver/hardware
- Hash สื่อใช้ size/mtime/head/tail ตาม core เดิม; การแก้เฉพาะกลางไฟล์ใหญ่พร้อมคง size/mtime อาจไม่ถูกตรวจพบ
- Comp ที่มี expression/opaque plugin values ติดตาม `.aep` ทั้งไฟล์เพื่อไม่ใช้ render เก่า จึงอาจ invalidate หลาย comp; image sequences ตรวจไฟล์ในกลุ่ม prefix/extension เดียวกัน
- หนึ่ง server/CLI ต่อโฟลเดอร์โปรเจกต์: มี guard งานใน server และป้องกัน overwrite ของ output แต่ยังไม่มี cross-process project lock
- การสร้างท่อนใหม่ decode ตั้งแต่ต้นเพื่อรักษา fps grid; ฟุตเทจยาวที่ in-point อยู่ลึกอาจใช้เวลามาก
- ขั้นถัดไปใน DESIGN เช่นคลังเทคนิค, รับบรีฟ/PDF/วิดีโอ, asset scan/transcript และ Smart Edit phase 3 ยังไม่ได้ทำ

อ้างอิงพฤติกรรม render engine: [Adobe automated rendering](https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html) ส่วน compatibility ของเครื่องนี้ยึดผลเทสต์ที่ระบุข้างต้น
