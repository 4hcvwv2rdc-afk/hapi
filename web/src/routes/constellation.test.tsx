import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConstellationFleetView } from './constellation'

const base = { machines: [], sessions: [], loading: false, error: null, online: true, onRetry: vi.fn() }

describe('ConstellationFleetView', () => {
    it('keeps offline distinct from request errors and exposes no mutation controls', () => {
        render(<ConstellationFleetView {...base} online={false} />)
        expect(screen.getByText('No connection to HAPI')).toBeInTheDocument()
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('shows a truthful loading state', () => {
        render(<ConstellationFleetView {...base} loading />)
        expect(screen.getByLabelText('Loading fleet')).toBeInTheDocument()
        expect(screen.queryByText('No sessions or machines observed yet')).toBeNull()
    })

    it('shows the exact request failure and retries only reads', () => {
        const onRetry = vi.fn()
        render(<ConstellationFleetView {...base} error="snapshot refused" onRetry={onRetry} />)
        expect(screen.getByRole('alert')).toHaveTextContent('snapshot refused')
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(onRetry).toHaveBeenCalledOnce()
    })

    it('renders HAPI machine capacity and session activity without claiming Watchdog verification', () => {
        render(<ConstellationFleetView {...base}
            machines={[{ id: 'm1', active: true, metadata: { host: 'air.local' }, health: { cpuPercent: 25, memoryPercent: 80, collectedAt: Date.now() } } as never]}
            sessions={[{ id: 's1', active: true, thinking: true, pendingRequestsCount: 0, metadata: { name: 'route review', flavor: 'codex' } } as never]} />)
        expect(screen.getByText(/25% CPU · 80% memory · observed \d+s ago/)).toBeInTheDocument()
        expect(screen.getByText('working')).toBeInTheDocument()
        expect(screen.getByText(/Watchdog evidence remains independent/)).toBeInTheDocument()
        expect(screen.queryByText(/verified|satisfied/i)).toBeNull()
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('does not present capacity values without a valid HAPI observation timestamp', () => {
        render(<ConstellationFleetView {...base}
            machines={[{ id: 'm1', active: true, metadata: { host: 'air.local' }, health: { cpuPercent: 25, memoryPercent: 80 } } as never]} />)
        expect(screen.getByText('capacity observation invalid')).toBeInTheDocument()
        expect(screen.queryByText(/25% CPU/)).toBeNull()
    })
})
