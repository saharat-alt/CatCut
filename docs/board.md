# บอร์ด (storyboard / บรีฟ) — วิธีใช้กับ Claude

บอร์ดคือ **ตัวตัดสินสูงสุด** ของงาน (DESIGN §13.2.1): เครื่องมือชุดนี้แค่อ่านบอร์ด ตรวจความขัดแย้ง และวัดว่าคัทต่างจากบอร์ดตรงไหน ไม่มีกฎสไตล์ตายตัว

## ขั้นตอน

1. **ยืนยันฉบับก่อนทำงาน** — `board_import {path}` (dry run) คืน:
   - `pdf` (title, วันที่แก้ล่าสุด, จำนวนหน้า), `file.sha256`, `versionHints` (v3, rev2, final, ฉบับที่ 2, วันที่)
   - `siblings` ไฟล์บอร์ดอื่นในโฟลเดอร์เดียวกัน (`newer: true` = อาจมีฉบับใหม่กว่า)
   - `current` เทียบกับบอร์ดที่ใช้อยู่ (คนละไฟล์ / ไฟล์เดิมแต่เนื้อหาเปลี่ยน)
   - `confirm` ประโยคสำหรับถามผู้ใช้ว่า "ใช่ฉบับล่าสุดไหม" — **ถามทุกครั้งที่บอร์ดเปลี่ยน**
2. **PDF**: Claude เปิด PDF ดูด้วยตา (รูป, ข้อความบนจอ, ลำดับ) แล้วเทียบกับ `board` (ร่างจาก heuristic) และ `pages` (ข้อความดิบรายหน้า) จากนั้นส่งบอร์ดที่ถูกต้องด้วย `board_set {board, sourceSha256}`
   - ร่างอัตโนมัติจับ: เลข slot ต้นบรรทัด (01, 02, 28r), เวลา `0:12`, `0:05-0:09`, `00:00:12:00`, ไทม์โค้ดต้นทางแบบ `0.03`, ความยาว `5s`/`5 วิ`, ชื่อไฟล์, ข้อความในเครื่องหมายคำพูด, หัวข้อ chapter, `Total 3:00`
   - `detections[].confidence: 'low'` = น่าจะไม่ใช่ slot (เช่นเลขหน้า)
   - PDF ที่เป็นภาพสแกนไม่มีข้อความ → อ่านด้วยตาแล้ว `board_set` อย่างเดียว
3. **CSV/JSON**: `board_import {path, apply: true}` ได้เลย
   - CSV: หัวตาราง = ชื่อฟิลด์ `id, order, chapter, boardStartFrame, boardDurFrames, boardStart, boardDur, sourceHint, sourceTc, onScreenText, notes, thumb, status` (คอลัมน์อื่น = error); แถวพิเศษ `#target,3:00` และ `#chapter,<ชื่อ>,<เริ่ม>,<ยาว>`
   - JSON: `{target?, chapters?, slots: [...]}` หรือ array ของ slot
4. **ตรวจบอร์ด** — `board_check {footageDir?}`: ความยาว chapter vs slot vs เป้า, slot ซ้ำ/เลขข้าม, เวลาซ้อน/ช่องว่าง, ข้อความที่สะกดต่างกันเล็กน้อย; ถ้าให้ `footageDir` จะตรวจว่ามีไฟล์/โฟลเดอร์ขึ้นต้นด้วยเลข slot ครบ (`01_city/`, `28r-logo.mov`) และรายงานไฟล์มีเลขที่ไม่ตรง slot ใด (element นอกบอร์ด?) — ถามผู้ใช้ก่อนแก้อะไร
5. **ผูกคลิปกับ slot** — `board_link {map?, auto?, apply}` (auto เดาจาก marker หรือชื่อไฟล์/โฟลเดอร์ต้นทาง)
6. **เทียบคัทกับบอร์ดหลัง build** — `board_vs_cut {version?, toleranceFrames?}` → `out/<version>/board_vs_cut.html` (ไม่เขียนทับ: `_2`, `_3`…) ภาพคู่ บอร์ด | เฟรมจาก master, ตาราง drift ราย slot/chapter (เฟรม + timecode), slot ที่หาย, คลิปนอกบอร์ด, ลำดับผิด, ความยาวรวม vs เป้า + `issues` (QcIssue kind `board`)
7. **ความยาวไม่ตรงเป้า** — `fit_duration {strategy: proportional|tail|cards, flexible?, lock?, shiftAudio?}` (dry run ก่อน, `apply: true` สำรองไทม์ไลน์ใน `history/` ย้อนได้ด้วย `timeline_restore`); ไม่ขยับ in-point, ยืดได้ไม่เกิน handle ต้นทาง/dissolve, ตรวจด้วย validateTimeline

## ที่เก็บ
- บอร์ดปัจจุบัน: `p.board` + `<project>/board.json` (มี sha256 ของไฟล์ต้นทาง)
- บอร์ดก่อนหน้า: `history/board-<เวลา>-<n>.json` ทุกครั้งที่เปลี่ยน
- เวลาในบอร์ดเก็บเป็น **เฟรม** ตาม fps ของโปรเจกต์; ช่อง `boardStart`/`boardDur`/`target` รับข้อความเวลาแล้วแปลงให้ (`0:12` = 12 วิ, `0.03` = 3 วิ, ตัวเลขเปล่า = วินาที)
