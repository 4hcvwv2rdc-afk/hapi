import { useMemo } from 'react'
import { Navigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSessions } from '@/hooks/queries/useSessions'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { getMachineTitle } from '@/hooks/useMachineLabels'
import type { Machine, SessionSummary } from '@/types/api'

export function constellationFleetEnabled(): boolean {
    return import.meta.env.VITE_CONSTELLATION_FLEET === 'true'
}

function sessionState(session: SessionSummary): string {
    if (!session.active) return 'ended'
    if (session.pendingRequestsCount > 0) return 'needs you'
    return session.thinking ? 'working' : 'idle'
}

function capacityText(machine: Machine): string {
    const health = machine.health
    if (!health) return 'capacity unknown'
    const collectedAt = typeof health.collectedAt === 'number' ? health.collectedAt : 0
    if (collectedAt <= 0 || collectedAt > Date.now() + 300_000) return 'capacity observation invalid'
    const ageSeconds = Math.max(0, Math.floor((Date.now() - collectedAt) / 1000))
    const cpu = typeof health.cpuPercent === 'number' ? `${Math.round(health.cpuPercent)}% CPU` : 'CPU unknown'
    const memory = typeof health.memoryPercent === 'number' ? `${Math.round(health.memoryPercent)}% memory` : 'memory unknown'
    const freshness = ageSeconds < 60 ? `${ageSeconds}s ago` : `${Math.floor(ageSeconds / 60)}m ago`
    return `${cpu} · ${memory} · observed ${freshness}`
}

export function ConstellationFleetView(props: {
    machines: Machine[]
    sessions: SessionSummary[]
    loading: boolean
    error: string | null
    online: boolean
    onRetry: () => void
}) {
    const rows = useMemo(() => {
        const machineRows = props.machines.map(machine => ({
            id: `machine:${machine.id}`,
            kind: 'machine',
            name: getMachineTitle(machine),
            state: machine.active ? 'connected' : 'offline',
            detail: capacityText(machine),
        }))
        const sessionRows = props.sessions.map(session => ({
            id: `session:${session.id}`,
            kind: 'session',
            name: session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || session.id,
            state: sessionState(session),
            detail: session.metadata?.flavor || 'agent unknown',
        }))
        return [...machineRows, ...sessionRows]
    }, [props.machines, props.sessions])

    return (
        <main className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]" aria-labelledby="constellation-title">
            <header className="border-b border-[var(--app-divider)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">HAPI fleet</p>
                <h1 id="constellation-title" className="text-xl font-semibold">Constellation</h1>
                <p className="text-sm text-[var(--app-hint)]">Read-only HAPI discovery. Watchdog evidence remains independent.</p>
            </header>
            {!props.online ? (
                <section className="m-4 rounded-lg border border-dashed border-[var(--app-divider)] p-4" role="status">
                    <h2 className="font-semibold">No connection to HAPI</h2>
                    <p className="text-sm text-[var(--app-hint)]">Fleet state is unknown. HAPI retries automatically.</p>
                </section>
            ) : props.error ? (
                <section className="m-4 rounded-lg border border-red-500 p-4" role="alert">
                    <h2 className="font-semibold">Couldn’t load fleet data from HAPI</h2>
                    <p className="text-sm text-[var(--app-hint)]">{props.error}</p>
                    <button type="button" className="mt-3 rounded-md border px-3 py-2" onClick={props.onRetry}>Retry</button>
                </section>
            ) : props.loading ? (
                <section className="space-y-2 p-4" aria-label="Loading fleet">
                    {[0, 1, 2, 3].map(index => <div key={index} className="h-14 animate-pulse rounded-lg bg-[var(--app-secondary-bg)] motion-reduce:animate-none" />)}
                </section>
            ) : rows.length === 0 ? (
                <section className="m-auto max-w-md p-6 text-center">
                    <h2 className="font-semibold">No sessions or machines observed yet</h2>
                    <p className="mt-1 text-sm text-[var(--app-hint)]">Once HAPI reports a session or machine, it appears here.</p>
                </section>
            ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Fleet roster">
                    {rows.map(row => (
                        <li key={row.id} className="flex min-h-14 items-center gap-3 border-b border-[var(--app-divider)] px-4 py-3">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border font-mono text-xs" aria-hidden="true">{row.kind === 'machine' ? 'M' : 'S'}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{row.name}</span>
                                <span className="block text-sm text-[var(--app-hint)]">{row.detail}</span>
                            </span>
                            <span className="shrink-0 font-mono text-xs text-[var(--app-hint)]">{row.state}</span>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    )
}

export default function ConstellationPage() {
    const { api } = useAppContext()
    const online = useOnlineStatus()
    const machines = useMachines(api, true)
    const sessions = useSessions(api)
    if (!constellationFleetEnabled()) return <Navigate to="/sessions" replace />
    const retry = () => { void Promise.all([machines.refetch(), sessions.refetch()]) }
    return <ConstellationFleetView machines={machines.machines} sessions={sessions.sessions}
        loading={machines.isLoading || sessions.isLoading} error={machines.error || sessions.error}
        online={online} onRetry={retry} />
}
