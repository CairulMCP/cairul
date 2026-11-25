---
name: cairul-journey
description: Use when starting or resuming a work item in a project with Cairul enabled. Follow the journey through completion.
---

1. Before working on the item, call `journey_start` with its `work_item_url` and `session_id`. Cairul selects the plan and returns it with the journey ID. Use the current Codex harness session ID for `session_id`. Read `CODEX_SESSION_ID` if set, or `CODEX_THREAD_ID` for a top-level Codex session. Ask for any missing required values. If the work item already has a `journey_id`, resume it with `journey_status`.
2. Use Cairul's plan and the work item's requirements to outline the general steps needed to complete the whole task and any required follow-through. Carry out every applicable step.
3. After following the plan in full, call `journey_status`. While the journey is active, address each incomplete check in the current phase and recheck journey status. When Cairul reports `ready_to_complete`, call `journey_complete`. Keep working through any remaining checks until Cairul returns `status: completed`, then report the confirmed completion and journey ID to the user.
4. If a check requires user action or manual confirmation, ask for it and keep working on any remaining steps you can complete. If that action blocks all further progress, report the blocker and journey ID so the journey can be resumed. Use `journey_abort` when the user asks to stop it.
