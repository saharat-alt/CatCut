# EDITMCP core implementation status

ตรวจวันที่ 11 ตุลาคม 2026 เวลาไทย บน branch `codex/finish-editmcp` จาก scaffold `ffd2d09` โดยรับไฟล์ที่ Claude เขียนค้างไว้มารวมและทำต่อ

## ผลที่ตรวจแล้ว

- `npm test`: 112 tests ผ่านทั้งหมดใน 11 files; ไม่มี skipped tests
- `npm run build`: ผ่าน TypeScript compiler; มี CLI และ server ใน `dist/`
- `npm run typecheck`: ผ่าน
- `node tests/stdio_smoke.mjs`: ผ่าน MCP stdio ของ CLI ที่ compile แล้วจริง ตั้งแต่ doctor → project/asset/timeline → build สองครั้ง → QC → export/import XML
- `node dist/mcp/cli.js doctor`: พบ ffmpeg/ffprobe 9.0.1 และ Adobe 2026; ไม่เปิด Adobe เพื่ออ่านเวอร์ชัน
- `npm audit --omit=dev`: ไม่พบช่องโหว่ใน production dependencies ณ เวลาตรวจ

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

## ขอบเขตที่ยังไม่ยืนยัน

- ไม่เปิด After Effects/aerender ตาม `CLAUDE.md` และไม่แตะงาน `D:\261009_STB50Y_THAI-WORLD_CSR` ตัว AE backend/process และ JSX host ถูกทดสอบด้วย mock เท่านั้น
- ต้องยืนยัน `-m -noui`, plugin/font, template ProRes, Lossless fallback, project saving และ PNG preview ใน AE 2026 จริง
- ต้อง import/export XML ใน Premiere 2026 จริง โดยเฉพาะ odd dissolve, scale, path ไทย และฟุตเทจต่าง fps; reader จำกัด V1 และส่ง warning เมื่อทิ้งสิ่งที่โมเดลไม่รองรับ
- การ decode/probe preset ไม่ใช่การรับรองการ ingest ของสถานีทีวีหรือ color pipeline
- ยังไม่ทดสอบ GPU จริง; inventory ใน doctor หมายถึง encoder ที่ ffmpeg มี ไม่ได้ยืนยัน driver/hardware
- Hash สื่อใช้ size/mtime/head/tail ตาม core เดิม; การแก้เฉพาะกลางไฟล์ใหญ่พร้อมคง size/mtime อาจไม่ถูกตรวจพบ
- Comp ที่มี expression/opaque plugin values ติดตาม `.aep` ทั้งไฟล์เพื่อไม่ใช้ render เก่า จึงอาจ invalidate หลาย comp; image sequences ตรวจไฟล์ในกลุ่ม prefix/extension เดียวกัน
- หนึ่ง server/CLI ต่อโฟลเดอร์โปรเจกต์: มี guard งานใน server และป้องกัน overwrite ของ output แต่ยังไม่มี cross-process project lock
- การสร้างท่อนใหม่ decode ตั้งแต่ต้นเพื่อรักษา fps grid; ฟุตเทจยาวที่ in-point อยู่ลึกอาจใช้เวลามาก
- ขั้นถัดไปใน DESIGN เช่นคลังเทคนิค, รับบรีฟ/PDF/วิดีโอ, asset scan/transcript และ UI ไม่อยู่ใน core build ที่ Claude เริ่มไว้

อ้างอิงพฤติกรรม render engine: [Adobe automated rendering](https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html) ส่วน compatibility ของเครื่องนี้ยึดผลเทสต์ที่ระบุข้างต้น
