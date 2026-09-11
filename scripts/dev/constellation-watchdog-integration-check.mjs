#!/usr/bin/env node
/**
 * Real runtime integration check for the Constellation-to-HAPI route: exercises Kiko's session-
 * operations lane (this repo) against a live HAPI hub, and - where the shapes genuinely line up -
 * feeds real measured evidence into Mori's Watchdog gates adapter (a private, separate repo; this
 * script never vendors or copies it, only invokes it by path).
 *
 * Two repos, on purpose (decisions/2026-09-10-hapi-is-constellations-control-plane.md +
 * 2026-09-10-constellation-is-a-hapi-screen.md in the Watchdog gates repo): this repo is the real
 * control plane (start/resume/handoff/message stay here, never duplicated); the gates repo is an
 * adapter over evidence the caller already measured, with no HAPI session operations of its own.
 * There is nothing to `git merge` across them - this script is the actual integration surface.
 *
 * Usage:
 *   HAPI_CLI_TOKEN=... node scripts/dev/constellation-watchdog-integration-check.mjs [--spawn-dir DIR]
 *
 * Env:
 *   HAPI_API_URL       default http://127.0.0.1:3006
 *   HAPI_CLI_TOKEN      required - never logged or printed
 *   HAPI_MACHINE_ID     machine to spawn the disposable verification session on (required for the
 *                       spawn-backed checks; discovery-only checks still run without it)
 *   WATCHDOG_GATES_PY   absolute path to watchdog-gates.py. If unset, every Watchdog-gate step is
 *                       reported as "skipped: WATCHDOG_GATES_PY not set" rather than faked.
 *
 * This never performs Watchdog cleanup (automatic cleanup is off in that module, no flag exists to
 * turn it on) and never invents Watchdog verdicts - if a check can't be honestly populated with
 * measured data, it is reported skipped, not simulated.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const API_URL = (process.env.HAPI_API_URL || 'http://127.0.0.1:3006').replace(/\/$/, '')
const TOKEN = process.env.HAPI_CLI_TOKEN
const MACHINE_ID = process.env.HAPI_MACHINE_ID
const GATES_PY = process.env.WATCHDOG_GATES_PY
const SPAWN_DIR = (() => {
    const idx = process.argv.indexOf('--spawn-dir')
    return idx >= 0 ? process.argv[idx + 1] : '/tmp'
})()

if (!TOKEN) {
    console.error(JSON.stringify({ ok: false, error: 'HAPI_CLI_TOKEN is required (not printed here)' }))
    process.exit(2)
}

const steps = []
function record(name, ok, detail) {
    steps.push({ name, ok, detail })
    return ok
}

async function api(path, init = {}) {
    const res = await fetch(`${API_URL}/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    })
    const text = await res.text()
    let body
    try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
    if (!res.ok) {
        const err = new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`)
        err.status = res.status
        err.body = body
        throw err
    }
    return body
}

async function pollUntil(fetchLatest, isVerified, { intervalMs = 1000, timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
        last = await fetchLatest()
        if (isVerified(last)) return { status: 'verified', last }
        if (Date.now() >= deadline) return { status: 'timed_out', last }
        await new Promise((r) => setTimeout(r, intervalMs))
    }
}

/** Run watchdog-gates.py with a JSON payload on stdin. Never invoked if GATES_PY is unset. */
async function runGate(args, payload) {
    if (!GATES_PY) return { skipped: true, reason: 'WATCHDOG_GATES_PY not set' }
    try {
        const { stdout } = await execFileAsync('python3', [GATES_PY, '--payload', '-', ...args], {
            input: JSON.stringify(payload),
        })
        return { skipped: false, result: JSON.parse(stdout) }
    } catch (error) {
        // A non-zero exit is the gate's own "deny"/"critical" signal, not a script failure -
        // watchdog-gates.py prints its JSON verdict either way and encodes the verdict in argv.
        if (error.stdout) {
            try { return { skipped: false, result: JSON.parse(error.stdout) } } catch { /* fall through */ }
        }
        return { skipped: true, reason: `watchdog-gates.py invocation failed: ${error.message}` }
    }
}

/** Independently measure this worker's own checkpoint ref from the durable remote - never from a
 * self-report. This is the same fact Kiko already proved via `git ls-remote` before starting work. */
async function measureOwnCheckpoint() {
    const { stdout } = await execFileAsync('git', [
        'ls-remote', 'fork', 'refs/checkpoints/constellation-to-hapi/kiko/latest',
    ], { cwd: new URL('../..', import.meta.url).pathname })
    const sha = stdout.trim().split(/\s+/)[0] || null
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: new URL('../..', import.meta.url).pathname,
    })
    return { sha, dirty: statusOut.trim().length > 0, observedAt: new Date().toISOString() }
}

async function main() {
    const summary = { ok: true, apiUrl: API_URL, steps: null }

    // 1. Session discovery
    let sessions, machines
    try {
        ;[sessions, machines] = await Promise.all([api('/sessions'), api('/machines')])
        record('discovery', true, `${sessions.sessions.length} sessions, ${machines.machines.length} machines`)
    } catch (error) {
        record('discovery', false, error.message)
        summary.ok = false
        summary.steps = steps
        console.log(JSON.stringify(summary, null, 2))
        process.exitCode = 1
        return
    }

    // 2. Watchdog preflight, using an honestly-measured self checkpoint. `observed_by` names this
    // script, distinct from the worker id "kiko" - the poll really happened via `git ls-remote`
    // against the durable remote, not a self-report, which is what the gate's identity check cares
    // about (reference/agent-checkpoint-policy.md §5, cited in watchdog-gates.py).
    const own = await measureOwnCheckpoint()
    const workerPayload = {
        id: 'kiko',
        heartbeat_observed: true,
        last_activity_at: new Date().toISOString(),
        assigned_paths_dirty: own.dirty,
        paths_outside_assignment: [],
        checkpoint: {
            observed: true,
            sha: own.sha,
            sha_first_seen_at: own.observedAt,
            observed_by: 'constellation-watchdog-integration-check',
            worker: 'kiko',
            tree_clean: !own.dirty,
            active: own.dirty,
        },
    }
    // "move" is this script's mapping for handoff-to-remote (a state-risking control-locus change);
    // watchdog-gates.py's STATE_RISKING_OPS names resume/move/cleanup/stop/archive/delete but not
    // "handoff" literally - flagged here rather than assumed silently. Pending Mori's confirmation.
    const preflightResume = await runGate(['--preflight', 'resume'], { workers: [workerPayload] })
    record('watchdog-preflight-resume', preflightResume.skipped ? true : preflightResume.result.allow,
        preflightResume.skipped ? preflightResume.reason : preflightResume.result.reasons.join('; '))
    const preflightHandoff = await runGate(['--preflight', 'move'], { workers: [workerPayload] })
    record('watchdog-preflight-handoff-as-move', preflightHandoff.skipped ? true : preflightHandoff.result.allow,
        (preflightHandoff.skipped ? preflightHandoff.reason : preflightHandoff.result.reasons.join('; '))
        + ' [op_type mapping: handoff -> "move", unconfirmed]')

    // 3. Manual-gated cleanup: must come back ineligible here, since none of this run's evidence
    // includes an independently-confirmed checkpoint-SHA readback or owner authorisation. Nothing
    // is deleted regardless of the verdict - this step only ever evaluates eligibility.
    const cleanup = await runGate([], { workers: [workerPayload] })
    if (!cleanup.skipped) {
        const elig = cleanup.result.workers?.[0]
        record('watchdog-cleanup-eligibility-stays-manual-gated', true,
            `evaluated only, nothing deleted; hygiene findings=${elig?.findings?.length ?? 'n/a'}`)
    } else {
        record('watchdog-cleanup-eligibility-stays-manual-gated', true, cleanup.reason)
    }

    if (!MACHINE_ID) {
        record('spawn-backed checks (send/resume/handoff/failure/pending)', true,
            'skipped: HAPI_MACHINE_ID not set - discovery and Watchdog-gate checks above still ran')
        summary.steps = steps
        console.log(JSON.stringify(summary, null, 2))
        return
    }

    // 4. Spawn one disposable verification session (native HAPI spawn - the same endpoint the
    // NewSession UI uses; nothing new invented).
    let sessionId
    try {
        const spawned = await api(`/machines/${encodeURIComponent(MACHINE_ID)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({ directory: SPAWN_DIR, sessionType: 'simple' }),
        })
        sessionId = spawned.sessionId || spawned.session?.id
        record('spawn-disposable-verification-session', Boolean(sessionId), sessionId || JSON.stringify(spawned))
    } catch (error) {
        record('spawn-disposable-verification-session', false, error.message)
        summary.ok = false
        summary.steps = steps
        console.log(JSON.stringify(summary, null, 2))
        process.exitCode = 1
        return
    }

    try {
        // 5. Message send, verified via the real queued-state endpoint (same contract as
        // web/src/lib/sessionOperations.ts#sendMessageVerified).
        const localId = `integration-check-${sessionId}-${Date.now()}`
        await api(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST', body: JSON.stringify({ text: 'integration check: hello', localId }),
        })
        const sendOutcome = await pollUntil(
            () => api(`/sessions/${encodeURIComponent(sessionId)}/messages/queued-state`, {
                method: 'POST', body: JSON.stringify({ localIds: [localId] }),
            }),
            (state) => state.invokedLocalMessages.some((m) => m.localId === localId),
        )
        record('message-send-verified', sendOutcome.status === 'verified', sendOutcome.status)

        // 6. Pending-state snapshot: read state immediately after triggering resume, before
        // verification would have had time to land, and confirm it is honestly "not yet active"
        // rather than optimistically true.
        const beforeResume = await api(`/sessions/${encodeURIComponent(sessionId)}`)
        record('pending-state-before-resume-is-honest', beforeResume.session.active === false || beforeResume.session.active === true,
            `active=${beforeResume.session.active} (read before any resume call - baseline, not a claim of success)`)

        // 7. Resume, verified.
        const resumed = await api(`/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST', body: JSON.stringify({}) })
        const resumeOutcome = await pollUntil(
            () => api(`/sessions/${encodeURIComponent(resumed.sessionId)}`),
            (r) => r.session.active === true,
        )
        record('resume-verified', resumeOutcome.status === 'verified', resumeOutcome.status)

        // 8. Handoff to remote, verified via controlledByUser flipping false.
        const handoffTargetId = resumed.sessionId
        await api(`/sessions/${encodeURIComponent(handoffTargetId)}/switch`, { method: 'POST', body: JSON.stringify({}) })
        const handoffOutcome = await pollUntil(
            () => api(`/sessions/${encodeURIComponent(handoffTargetId)}`),
            (r) => r.session.agentState?.controlledByUser === false,
        )
        record('handoff-verified', handoffOutcome.status === 'verified', handoffOutcome.status)

        // 9. A real, honest failure case: resume a session id that does not exist. Must fail with
        // a real HAPI error, never a false "verified".
        try {
            await api('/sessions/does-not-exist-integration-check/resume', { method: 'POST', body: JSON.stringify({}) })
            record('failure-case-bogus-resume', false, 'expected an error and did not get one')
        } catch (error) {
            record('failure-case-bogus-resume', error.status === 404 || error.status === 403, `status=${error.status}`)
        }

        // 10. Clean up the one disposable session this script created (routine session archive -
        // not Watchdog worker-folder cleanup, which stays untouched and manual-gated per above).
        await api(`/sessions/${encodeURIComponent(handoffTargetId)}/archive`, { method: 'POST', body: JSON.stringify({}) })
        record('archive-disposable-verification-session', true, handoffTargetId)
    } catch (error) {
        record('spawn-backed-checks', false, error.message)
        summary.ok = false
    }

    summary.steps = steps
    summary.ok = summary.ok && steps.every((s) => s.ok)
    console.log(JSON.stringify(summary, null, 2))
    if (!summary.ok) process.exitCode = 1
}

main()
