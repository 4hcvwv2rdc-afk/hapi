import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { ConstellationSessionOperations } from './constellationOperations'

vi.mock('@/lib/sessionOperations', () => ({
    resumeSessionVerified: vi.fn(),
    handoffToRemoteVerified: vi.fn(),
    sendMessageVerified: vi.fn(),
}))

import { handoffToRemoteVerified, resumeSessionVerified, sendMessageVerified } from '@/lib/sessionOperations'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
}

const api = {} as ApiClient

describe('ConstellationSessionOperations', () => {
    it('shows a truthful empty state and no controls when HAPI has reported no sessions', () => {
        render(<ConstellationSessionOperations api={api} sessions={[]} />)
        expect(screen.getByText(/No sessions observed yet/)).toBeInTheDocument()
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('lists each session with its operations and disables handoff for an ended session', () => {
        render(<ConstellationSessionOperations api={api} sessions={[
            { id: 's1', active: true, metadata: { name: 'route review' } } as never,
            { id: 's2', active: false, metadata: { name: 'ended one' } } as never,
        ]} />)
        expect(screen.getByText('route review')).toBeInTheDocument()
        expect(screen.getByText('ended one')).toBeInTheDocument()
        const rows = screen.getAllByRole('listitem')
        expect(rows).toHaveLength(2)
        const endedRow = rows.find((row) => row.textContent?.includes('ended one'))!
        const { getByRole } = within(endedRow)
        expect(getByRole('button', { name: 'Hand off to remote' })).toBeDisabled()
    })

    it('shows pending, then verified, and never claims success before HAPI confirms it', async () => {
        const { promise, resolve } = deferred<{ status: 'verified' }>()
        vi.mocked(resumeSessionVerified).mockReturnValue(promise)
        render(<ConstellationSessionOperations api={api} sessions={[{ id: 's1', active: true, metadata: { name: 'route review' } } as never]} />)

        fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
        expect(resumeSessionVerified).toHaveBeenCalledWith(api, 's1')
        expect(screen.getByText(/waiting for HAPI to confirm/)).toBeInTheDocument()
        expect(screen.queryByText(/confirmed by HAPI/)).toBeNull()

        resolve({ status: 'verified' })
        expect(await screen.findByText('Resume: confirmed by HAPI')).toBeInTheDocument()
    })

    it('surfaces a timeout as unconfirmed, not as success', async () => {
        vi.mocked(handoffToRemoteVerified).mockResolvedValue({ status: 'timed_out' })
        render(<ConstellationSessionOperations api={api} sessions={[{ id: 's1', active: true, metadata: { name: 'route review' } } as never]} />)
        fireEvent.click(screen.getByRole('button', { name: 'Hand off to remote' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/not confirmed yet/)
    })

    it('surfaces a rejected transaction with the real error, not a generic failure', async () => {
        vi.mocked(sendMessageVerified).mockResolvedValue({ status: 'failed', error: 'no machine online' })
        render(<ConstellationSessionOperations api={api} sessions={[{ id: 's1', active: true, metadata: { name: 'route review' } } as never]} />)
        fireEvent.change(screen.getByLabelText('Message text for route review'), { target: { value: 'ping' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
        expect(sendMessageVerified).toHaveBeenCalledWith(api, 's1', 'ping')
        expect(await screen.findByRole('alert')).toHaveTextContent('no machine online')
    })

    it('disables send-message until there is text to send', () => {
        render(<ConstellationSessionOperations api={api} sessions={[{ id: 's1', active: true, metadata: { name: 'route review' } } as never]} />)
        expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Message text for route review'), { target: { value: '  ' } })
        expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
        fireEvent.change(screen.getByLabelText('Message text for route review'), { target: { value: 'hi' } })
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    })
})
