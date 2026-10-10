---
description: แก้ตามโน้ตรีวิว (เสนอแผนก่อนลงมือ) · Apply review notes after confirming a plan
argument-hint: "[version]"
---
Use the catcut-editor skill and the CatCut MCP tools.

1. `review_notes` for version $ARGUMENTS (default: latest). Act ONLY on `actionable` notes; `parked` notes are information. `revertRequests` → `shot_revert`.
2. `rules_get`. Map each note (colour = intent, circled layer/shot, timecode) to concrete edits and show the plan as a short numbered list. Wait for the user's OK.
3. Apply with `timeline_edit` / `ae_edit` / `shot_revert`, then `build`.
4. Before saying a note is fixed, attach evidence with `rules_evidence` (one frame per instance). Offer `/catcut:review` for the next round.
