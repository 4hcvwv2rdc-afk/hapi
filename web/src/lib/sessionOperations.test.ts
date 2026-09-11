import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionResponse } from '@/types/api'
import { handoffToRemoteVerified, resumeSessionVerified, sendMessageVerified } from './sessionOperations'

/** Partial-session fixture, cast once here instead of scattered `as never`s below. */
function sessionResponse(partial: Record<string, unknown>): SessionResponse {
    return { session: partial } as unknown as SessionResponse
}

function createMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return {
        resumeSession: vi.fn(async () => 'session-A'),
        switchSession: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
        getSession: vi.fn(async () => sessionResponse({ id: 'session-A', active: false })),
        getQueuedState: vi.fn(async () => ({ queuedLocalIds: [], invokedLocalMessages: [] })),
        ...overrides,
    } as ApiClient
}

describe('sessionOperations', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    describe('resumeSessionVerified', () => {
        it('reports failed without polling when the resume call itself rejects', async () => {
            const api = createMockApi({ resumeSession: vi.fn(async () => { throw new Error('no machine online') }) })
            const outcome = await resumeSessionVerified(api, 'session-A')
            expect(outcome).toEqual({ status: 'failed', error: 'no machine online' })
            expect(api.getSession).not.toHaveBeenCalled()
        })

        it('does not report verified until a read shows the session active', async () => {
            const getSession = vi.fn()
                .mockResolvedValueOnce(sessionResponse({ id: 'session-A', active: false }))
                .mockResolvedValueOnce(sessionResponse({ id: 'session-A', active: true }))
            const api = createMockApi({ getSession })
            const promise = resumeSessionVerified(api, 'session-A', { intervalMs: 10 })
            await vi.advanceTimersByTimeAsync(10)
            const outcome = await promise
            expect(outcome).toEqual({ status: 'verified' })
            expect(getSession).toHaveBeenCalledTimes(2)
        })

        it('follows the resumed session id returned by HAPI, not the requested id', async () => {
            const resumeSession = vi.fn(async () => 'session-B')
            const getSession = vi.fn(async (id: string) => sessionResponse({ id, active: id === 'session-B' }))
            const api = createMockApi({ resumeSession, getSession })
            const outcome = await resumeSessionVerified(api, 'session-A')
            expect(outcome).toEqual({ status: 'verified' })
            expect(getSession).toHaveBeenCalledWith('session-B')
        })

        it('times out instead of claiming success when the session never goes active', async () => {
            const api = createMockApi()
            const promise = resumeSessionVerified(api, 'session-A', { intervalMs: 10, timeoutMs: 25 })
            await vi.advanceTimersByTimeAsync(30)
            const outcome = await promise
            expect(outcome).toEqual({ status: 'timed_out' })
        })
    })

    describe('handoffToRemoteVerified', () => {
        it('does not report verified while HAPI still shows local (terminal) control', async () => {
            const getSession = vi.fn()
                .mockResolvedValueOnce(sessionResponse({ id: 'session-A', active: true, agentState: { controlledByUser: true } }))
                .mockResolvedValueOnce(sessionResponse({ id: 'session-A', active: true, agentState: { controlledByUser: false } }))
            const api = createMockApi({ getSession })
            const promise = handoffToRemoteVerified(api, 'session-A', { intervalMs: 10 })
            await vi.advanceTimersByTimeAsync(10)
            const outcome = await promise
            expect(outcome).toEqual({ status: 'verified' })
            expect(getSession).toHaveBeenCalledTimes(2)
        })

        it('reports failed when the switch call itself rejects', async () => {
            const api = createMockApi({ switchSession: vi.fn(async () => { throw new Error('session not active') }) })
            const outcome = await handoffToRemoteVerified(api, 'session-A')
            expect(outcome).toEqual({ status: 'failed', error: 'session not active' })
        })
    })

    describe('sendMessageVerified', () => {
        it('does not report verified while the message is still queued or indeterminate', async () => {
            let call = 0
            const getQueuedState = vi.fn(async (_sessionId: string, localIds: string[]) => {
                call += 1
                const localId = localIds[0]
                if (call === 1) return { queuedLocalIds: [localId], invokedLocalMessages: [] }
                if (call === 2) return { queuedLocalIds: [], indeterminateLocalIds: [localId], invokedLocalMessages: [] }
                return { queuedLocalIds: [], invokedLocalMessages: [{ localId, invokedAt: 1 }] }
            })
            const api = createMockApi({ getQueuedState })
            const promise = sendMessageVerified(api, 'session-A', 'hello', { intervalMs: 10 })
            await vi.advanceTimersByTimeAsync(10)
            await vi.advanceTimersByTimeAsync(10)
            const outcome = await promise
            expect(outcome).toEqual({ status: 'verified' })
            expect(call).toBe(3)
        })

        it('verifies against the exact generated localId', async () => {
            const getQueuedState = vi.fn(async (_sessionId: string, localIds: string[]) => ({
                queuedLocalIds: [],
                invokedLocalMessages: localIds.map((localId) => ({ localId, invokedAt: 1 })),
            }))
            const api = createMockApi({ getQueuedState })
            const outcome = await sendMessageVerified(api, 'session-A', 'hello')
            expect(outcome).toEqual({ status: 'verified' })
            const [sessionId, text, localId] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
            expect(sessionId).toBe('session-A')
            expect(text).toBe('hello')
            expect(localId).toContain('session-A')
        })

        it('times out rather than claiming delivery when HAPI never reports it invoked', async () => {
            const api = createMockApi()
            const promise = sendMessageVerified(api, 'session-A', 'hello', { intervalMs: 10, timeoutMs: 15 })
            await vi.advanceTimersByTimeAsync(20)
            const outcome = await promise
            expect(outcome).toEqual({ status: 'timed_out' })
        })
    })
})
