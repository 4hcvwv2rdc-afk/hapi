import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import {
    handoffToRemoteVerified,
    resumeSessionVerified,
    sendMessageVerified,
    type OperationOutcome,
} from '@/lib/sessionOperations'

type OperationKind = 'message' | 'resume' | 'handoff'

type RowOperationState =
    | { phase: 'idle' }
    | { phase: 'pending'; kind: OperationKind }
    | { phase: 'verified'; kind: OperationKind }
    | { phase: 'timed_out'; kind: OperationKind }
    | { phase: 'failed'; kind: OperationKind; error: string }

const KIND_LABEL: Record<OperationKind, string> = {
    message: 'Send message',
    resume: 'Resume',
    handoff: 'Hand off to remote',
}

function statusText(state: RowOperationState): string {
    switch (state.phase) {
        case 'idle':
            return ''
        case 'pending':
            return `${KIND_LABEL[state.kind]}: sent, waiting for HAPI to confirm…`
        case 'verified':
            return `${KIND_LABEL[state.kind]}: confirmed by HAPI`
        case 'timed_out':
            return `${KIND_LABEL[state.kind]}: not confirmed yet — HAPI hasn't reported the change. It may still land; check back.`
        case 'failed':
            return `${KIND_LABEL[state.kind]}: failed — ${state.error}`
    }
}

function statusRole(state: RowOperationState): 'status' | 'alert' | undefined {
    if (state.phase === 'idle') return undefined
    if (state.phase === 'failed' || state.phase === 'timed_out') return 'alert'
    return 'status'
}

/**
 * Session-operations transactions layer for the Constellation fleet: send
 * message, resume, and hand off to remote. Each button issues the real HAPI
 * mutation and then waits on a poll-verified read (web/src/lib/sessionOperations.ts)
 * before showing anything but "waiting for HAPI to confirm" - a transition is
 * never reported done until HAPI's own state says so. Deliberately separate
 * from ConstellationFleetView, which stays read-only discovery.
 */
export function ConstellationSessionOperations(props: {
    api: ApiClient
    sessions: SessionSummary[]
}) {
    const { api } = props
    const [drafts, setDrafts] = useState<Record<string, string>>({})
    const [opState, setOpState] = useState<Record<string, RowOperationState>>({})
    const controllers = useRef(new Map<string, AbortController>())

    useEffect(() => {
        const map = controllers.current
        return () => {
            for (const controller of map.values()) {
                controller.abort()
            }
            map.clear()
        }
    }, [])

    const sessions = useMemo(
        () => [...props.sessions].sort((a, b) => (a.metadata?.name || a.id).localeCompare(b.metadata?.name || b.id)),
        [props.sessions]
    )

    async function run(sessionId: string, kind: OperationKind, action: (signal: AbortSignal) => Promise<OperationOutcome>) {
        controllers.current.get(sessionId)?.abort()
        const controller = new AbortController()
        controllers.current.set(sessionId, controller)
        setOpState((prev) => ({ ...prev, [sessionId]: { phase: 'pending', kind } }))
        const outcome = await action(controller.signal)
        if (controller.signal.aborted) return
        setOpState((prev) => ({
            ...prev,
            [sessionId]: outcome.status === 'verified'
                ? { phase: 'verified', kind }
                : outcome.status === 'timed_out'
                    ? { phase: 'timed_out', kind }
                    : { phase: 'failed', kind, error: outcome.error },
        }))
    }

    if (sessions.length === 0) {
        return (
            <section className="border-t border-[var(--app-divider)] p-4" aria-label="Session operations">
                <h2 className="text-sm font-semibold">Session operations</h2>
                <p className="mt-1 text-sm text-[var(--app-hint)]">No sessions observed yet — operations appear once HAPI reports one.</p>
            </section>
        )
    }

    return (
        <section className="flex h-full min-h-0 flex-col border-t border-[var(--app-divider)]" aria-label="Session operations">
            <div className="shrink-0 px-4 py-3">
                <h2 className="text-sm font-semibold">Session operations</h2>
                <p className="mt-1 text-sm text-[var(--app-hint)]">
                    Send message, resume, and hand off use HAPI's existing transactions. Nothing here shows success until HAPI confirms it.
                </p>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Session operations list">
                {sessions.map((session) => {
                    const state = opState[session.id] ?? { phase: 'idle' as const }
                    const pending = state.phase === 'pending'
                    const draft = drafts[session.id] ?? ''
                    const label = session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || session.id
                    return (
                        <li key={session.id} className="border-b border-[var(--app-divider)] px-4 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                                <span className="shrink-0 font-mono text-xs text-[var(--app-hint)]">{session.active ? 'active' : 'ended'}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input
                                    type="text"
                                    className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                                    placeholder="Message text"
                                    aria-label={`Message text for ${label}`}
                                    value={draft}
                                    disabled={pending}
                                    onChange={(e) => setDrafts((prev) => ({ ...prev, [session.id]: e.target.value }))}
                                />
                                <button
                                    type="button"
                                    className="shrink-0 rounded-md border px-3 py-1 text-sm disabled:opacity-50"
                                    disabled={pending || draft.trim().length === 0}
                                    onClick={() => {
                                        const text = draft.trim()
                                        void run(session.id, 'message', () => sendMessageVerified(api, session.id, text))
                                    }}
                                >
                                    Send message
                                </button>
                                <button
                                    type="button"
                                    className="shrink-0 rounded-md border px-3 py-1 text-sm disabled:opacity-50"
                                    disabled={pending}
                                    onClick={() => {
                                        void run(session.id, 'resume', () => resumeSessionVerified(api, session.id))
                                    }}
                                >
                                    Resume
                                </button>
                                <button
                                    type="button"
                                    className="shrink-0 rounded-md border px-3 py-1 text-sm disabled:opacity-50"
                                    disabled={pending || !session.active}
                                    onClick={() => {
                                        void run(session.id, 'handoff', () => handoffToRemoteVerified(api, session.id))
                                    }}
                                >
                                    Hand off to remote
                                </button>
                            </div>
                            {state.phase !== 'idle' && (
                                <p className="mt-1 text-sm text-[var(--app-hint)]" role={statusRole(state)}>
                                    {statusText(state)}
                                </p>
                            )}
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
