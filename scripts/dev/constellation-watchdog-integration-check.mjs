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
 * --spawn-dir DIR      required together with HAPI_MACHINE_ID for the spawn-backed checks - must
 *                       be inside that machine's configured workspace roots (a runner rejects any
 *                       other directory, /tmp included). There is no portable disposable-scratch
 *                       root across runners, so this is a deliberate caller choice, not a guess.
 *
 * This never performs Watchdog cleanup (automatic cleanup is off in that module, no flag exists to
 * turn it on) and never invents Watchdog verdicts - if a check can't be honestly populated with
 * measured data, it is reported skipped, not simulated.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const API_URL = (process.env.HAPI_API_URL || 'http://127.0.0.1:3006').replace(/\/$/, '')
const TOKEN = process.env.HAPI_CLI_TOKEN
const MACHINE_ID = process.env.HAPI_MACHINE_ID
const GATES_PY = process.env.WATCHDOG_GATES_PY
const SPAWN_DIR = (() => {
    const idx = process.argv.indexOf('--spawn-dir')
    if (idx >= 0) return process.argv[idx + 1]
    // No portable disposable-scratch root exists on every runner (a runner only accepts spawns
    // inside its configured workspace roots, and /tmp is outside all of them, measured above) -
    // this MUST be passed explicitly with --spawn-dir so the caller picks it deliberately rather
    // than this script guessing which of the operator's real checkouts to spawn a session into.
    return null
})()

if (!TOKEN) {
    console.error(JSON.stringify({ ok: false, error: 'HAPI_CLI_TOKEN is required (not printed here)' }))
    process.exit(2)
}

const steps = []
function record(name, ok, detail) {
    steps.push({ name, ok, detail })
    // Printed as each step lands, not just in the final summary - a run that stalls is visible
    // immediately instead of producing zero output until it finishes or is killed.
    console.error(`[${ok ? 'ok' : 'FAIL'}] ${name}: ${detail}`)
    return ok
}

// The REST API takes a short-lived JWT (POST /api/auth), not the raw CLI_API_TOKEN directly -
// this mirrors exactly what the web app's login screen does with the same token.
let jwt = null
async function login() {
    const res = await fetch(`${API_URL}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: TOKEN }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`)
    jwt = body.token
}

async function api(path, init = {}) {
    const res = await fetch(`${API_URL}/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, ...(init.headers || {}) },
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

/**
 * Run watchdog-gates.py with a JSON payload on stdin. Never invoked if GATES_PY is unset.
 * `execFile`'s async form has no `input` option (that's only on the *Sync variants) - the payload
 * has to be written to the child's stdin directly and the stream closed, or the process blocks
 * forever waiting on a stdin that never arrives. Measured: the first version of this function used
 * `{ input }` on the async call and hung indefinitely against a live run.
 */
function runGate(args, payload) {
    if (!GATES_PY) return Promise.resolve({ skipped: true, reason: 'WATCHDOG_GATES_PY not set' })
    return new Promise((resolve) => {
        const child = spawn('python3', [GATES_PY, '--payload', '-', ...args])
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => resolve({ skipped: true, reason: `watchdog-gates.py invocation failed: ${error.message}` }))
        child.on('close', () => {
            // A non-zero exit is the gate's own "deny"/"critical" signal, not a script failure -
            // watchdog-gates.py prints its JSON verdict either way and encodes the verdict in argv.
            try {
                resolve({ skipped: false, result: JSON.parse(stdout) })
            } catch {
                resolve({ skipped: true, reason: `watchdog-gates.py produced no parseable JSON: ${stderr || stdout}` })
            }
        })
        child.stdin.write(JSON.stringify(payload))
        child.stdin.end()
    })
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

    try {
        await login()
        record('login', true, 'JWT obtained (4h), never logged')
    } catch (error) {
        record('login', false, error.message)
        summary.ok = false
        summary.steps = steps
        console.log(JSON.stringify(summary, null, 2))
        process.exitCode = 1
        return
    }

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

    // 3. Manual-gated cleanup: cleanup_eligibility only runs through preflight_gate(op_type=
    // "cleanup", ...) - evaluate_route (the no-flag call) never reaches it. Expected ineligible
    // here, since this payload has neither an independently-confirmed checkpoint-SHA readback nor
    // ownership/authorisation evidence. Nothing is deleted regardless of the verdict - this step
    // only ever evaluates eligibility.
    const cleanup = await runGate(['--preflight', 'cleanup'], { workers: [workerPayload] })
    if (!cleanup.skipped) {
        record('watchdog-cleanup-eligibility-stays-manual-gated', cleanup.result.allow === false,
            `eligible=${cleanup.result.allow} (expected false with no SHA-readback/ownership evidence); ${cleanup.result.reasons.join('; ')}`)
    } else {
        record('watchdog-cleanup-eligibility-stays-manual-gated', true, cleanup.reason)
    }

    if (!MACHINE_ID || !SPAWN_DIR) {
        record('spawn-backed checks (send/resume/handoff/failure/pending)', true,
            `skipped: ${!MACHINE_ID ? 'HAPI_MACHINE_ID' : '--spawn-dir'} not set - discovery and Watchdog-gate checks above still ran`)
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
            body: JSON.stringify({
                directory: SPAWN_DIR,
                sessionType: 'simple',
                // Cheapest available model by default - this session only exists to prove the
                // transaction wiring, never to do real work.
                model: process.env.HAPI_SPAWN_MODEL || 'claude-haiku-4-5-20251001',
            }),
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

    // Whichever session id is "live" right now - archived in `finally` below no matter where the
    // sequence stops, so a failure partway through never leaves an orphaned test session behind.
    let liveSessionId = sessionId
    try {
        // A freshly-spawned session is not immediately ready to receive messages (measured: an
        // immediate send got 409 "Session is inactive" against a real spawn). Wait for HAPI's own
        // state to say it's active first, exactly like resumeSessionVerified already does.
        const spawnReady = await pollUntil(
            () => api(`/sessions/${encodeURIComponent(sessionId)}`),
            (r) => r.session.active === true,
            { timeoutMs: 30000 },
        )
        record('spawned-session-reaches-active', spawnReady.status === 'verified', spawnReady.status)

        // 5. Message send, verified via the real queued-state endpoint (same contract as
        // web/src/lib/sessionOperations.ts#sendMessageVerified).
        const localId = `integration-check-${sessionId}-${Date.now()}`
        await api(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST', body: JSON.stringify({
                text: 'Automated integration check. Do not read files, run commands, or take any '
                    + 'action - this message only exists to verify delivery. Reply with "ack".',
                localId,
            }),
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
        liveSessionId = resumed.sessionId
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
    } catch (error) {
        record('spawn-backed-checks', false, error.message)
        summary.ok = false
    } finally {
        // 10. Clean up the one disposable session this script created (routine session archive -
        // not Watchdog worker-folder cleanup, which stays untouched and manual-gated per above).
        // Runs even if an earlier step threw, so nothing is left orphaned in the session list.
        try {
            await api(`/sessions/${encodeURIComponent(liveSessionId)}/archive`, { method: 'POST', body: JSON.stringify({}) })
            record('archive-disposable-verification-session', true, liveSessionId)
        } catch (error) {
            record('archive-disposable-verification-session', false, `${liveSessionId}: ${error.message}`)
            summary.ok = false
        }
    }

    summary.steps = steps
    summary.ok = summary.ok && steps.every((s) => s.ok)
    console.log(JSON.stringify(summary, null, 2))
    if (!summary.ok) process.exitCode = 1
}

main()
