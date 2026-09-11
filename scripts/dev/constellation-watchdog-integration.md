# Constellation-to-HAPI integration: two repos, one contract

`web/src/routes/constellation.tsx` + `constellationOperations.tsx` are the real control plane for
the Constellation fleet screen: session discovery, machine capacity, and the verified send-message
/ resume / handoff-to-remote transactions (`web/src/lib/sessionOperations.ts`). This repo is the
only caller of those HAPI endpoints for this feature — nothing else spawns, resumes, moves, or
messages a session on Constellation's behalf, by design.

An independent Watchdog gates adapter lives in a separate, private repository, not this one. It is
a pure function over evidence the caller already measured (no sockets, no subprocess, no file
reads, no HAPI session operations of its own) — `preflight_gate`, `worker_hygiene`,
`checkpoint_status`, `verify_transition`, `detect_false_completion`, `detect_abandoned_work`, and
`cleanup_eligibility` (manual-only; there is no flag to enable automatic cleanup). It exists so
that "did this transition really land" is answered by evidence, never by a worker's or HAPI's own
say-so.

## Why there is no cross-repo merge

The Watchdog gates module is in a private repository unrelated to `tiann/hapi`'s history. There is
nothing there to `git merge` into this fork, and there shouldn't be — mixing an unrelated private
repository's history into a public-facing fork would leak content that has no reason to be public.
The two lanes integrate at the **evidence boundary**, not the source-tree boundary: this repo
performs and verifies real HAPI operations; the gates module independently evaluates a JSON payload
of measured facts about those operations. `scripts/dev/constellation-watchdog-integration-check.mjs`
is that boundary made runnable — it calls this repo's real HAPI API for discovery/send/resume/
handoff, and (only if `WATCHDOG_GATES_PY` points at a local checkout) feeds the gates module real,
independently-measured worker/checkpoint evidence and checks its preflight and cleanup-eligibility
verdicts.

## Open question: op_type mapping for handoff

`preflight_gate(op_type, worker)` recognizes `start/resume/move/message/mention/cleanup/stop/
archive/delete`. There is no literal `handoff`. The integration-check script maps
`handoffToRemoteVerified` to `op_type="move"` (it changes who controls the session, which is a
state-risking operation per the gate's own `STATE_RISKING_OPS` list) — but this is Kiko's inference,
not something the gates module's author has confirmed. Treat any "handoff" preflight verdict in the
check's output as provisional until that mapping is confirmed on the gates side.

## What this integration deliberately does not do

- No Watchdog policy or cleanup logic is implemented here — the check script only ever *reads* a
  verdict from the gates module; it never deletes a worker folder or session on the strength of one.
- No parallel session/routing system — every HAPI operation in the check script is the same
  endpoint `constellationOperations.tsx` already calls.
- No fabricated evidence — if a check can't be honestly populated from something actually measured
  (e.g. `verify_transition`'s source/destination task-job-machine identity model, which doesn't have
  a natural mapping from this repo's `Session` shape without inventing fields), the script skips it
  rather than faking a payload. See the script's own comments for exactly which checks that applies
  to.

## Running it

```bash
HAPI_CLI_TOKEN=<your CLI_API_TOKEN> \
HAPI_MACHINE_ID=<a machine with agent-availability> \
WATCHDOG_GATES_PY=/path/to/watchdog-gates.py \
node scripts/dev/constellation-watchdog-integration-check.mjs --spawn-dir <path inside that machine's workspace roots>
```

Discovery and the Watchdog-gate preflight/cleanup-eligibility checks run with just
`HAPI_CLI_TOKEN`. The send/resume/handoff/failure/pending checks additionally spawn one disposable
verification session on `HAPI_MACHINE_ID` at `--spawn-dir` and archive it when done — never against
an existing session. `--spawn-dir` must be inside that machine's configured workspace roots (a
runner rejects anything else, `/tmp` included, and there is no portable disposable-scratch root
across runners) — pick it deliberately; the script will not guess one of your checkouts for you.
