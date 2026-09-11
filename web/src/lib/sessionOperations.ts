// Verified session-operations transactions: send message, resume, hand off to
// remote. Each transaction issues the existing HAPI mutation, then polls the
// existing HAPI read path until the destination state actually reflects it.
// A transaction is never reported successful on the strength of the mutation
// response alone — only on measured evidence from a follow-up read. HAPI
// remains the sole source of truth; nothing here invents parallel state.
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

export type OperationOutcome =
    | { status: 'verified' }
    | { status: 'timed_out' }
    | { status: 'failed'; error: string }

export type PollOptions = {
    /** Interval between verification reads, in ms. */
    intervalMs?: number
    /** Give up and report `timed_out` after this many ms with no verification. */
    timeoutMs?: number
    signal?: AbortSignal
}

const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 30_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
        }
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
    })
}

/**
 * Repeatedly reads current state via `fetchLatest` until `isVerified` accepts
 * it, or until `timeoutMs` elapses. Never resolves `verified` without a
 * measured read that satisfied the predicate.
 */
async function pollUntilVerified<T>(
    fetchLatest: () => Promise<T>,
    isVerified: (value: T) => boolean,
    opts: PollOptions = {}
): Promise<OperationOutcome> {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    for (;;) {
        let value: T
        try {
            value = await fetchLatest()
        } catch (err) {
            return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
        }
        if (isVerified(value)) {
            return { status: 'verified' }
        }
        if (Date.now() >= deadline) {
            return { status: 'timed_out' }
        }
        try {
            await sleep(intervalMs, opts.signal)
        } catch {
            return { status: 'timed_out' }
        }
    }
}

/**
 * Resume transaction: POST /sessions/:id/resume, then poll the resumed
 * session until HAPI reports it active. `resumeSession` can return a
 * different session id than the one requested (native resume semantics);
 * verification follows whichever id HAPI actually handed back.
 */
export async function resumeSessionVerified(
    api: ApiClient,
    sessionId: string,
    opts: PollOptions & { permissionMode?: string } = {}
): Promise<OperationOutcome> {
    let resumedId: string
    try {
        resumedId = await api.resumeSession(
            sessionId,
            opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : undefined
        )
    } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    return pollUntilVerified(
        () => api.getSession(resumedId).then((r) => r.session),
        (session: Session) => session.active === true,
        opts
    )
}

/**
 * Handoff transaction: POST /sessions/:id/switch (local -> remote), then poll
 * until HAPI reports the session no longer terminal-controlled. This is the
 * same `controlledByUser` field the CLI and web session UI already use to
 * distinguish local vs. remote control (cli/src/commands/resume.ts,
 * web/src/components/SessionChat.tsx) - no new identity is invented here.
 */
export async function handoffToRemoteVerified(
    api: ApiClient,
    sessionId: string,
    opts: PollOptions = {}
): Promise<OperationOutcome> {
    try {
        await api.switchSession(sessionId)
    } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    return pollUntilVerified(
        () => api.getSession(sessionId).then((r) => r.session),
        (session: Session) => session.agentState?.controlledByUser === false,
        opts
    )
}

/**
 * Message-routing transaction: POST /sessions/:id/messages with a fresh
 * localId, then poll the existing queued-state endpoint until HAPI reports
 * the message invoked (delivered into the agent's turn) rather than still
 * queued or indeterminate.
 */
export async function sendMessageVerified(
    api: ApiClient,
    sessionId: string,
    text: string,
    opts: PollOptions = {}
): Promise<OperationOutcome> {
    const localId = `constellation-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
        await api.sendMessage(sessionId, text, localId)
    } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    return pollUntilVerified(
        () => api.getQueuedState(sessionId, [localId]),
        (state) => state.invokedLocalMessages.some((m) => m.localId === localId),
        opts
    )
}
