import { describe, expect, it } from 'vitest'
import { privateLinkHistoryState } from '../app/utils/privateLinkHistory'

describe('private link history state', () => {
  it('removes bearer fragments while preserving navigation indices, queries and scroll', () => {
    const state = {
      current: '/presentations#secret',
      back: '/fr/recipient/invitations?view=short#another-secret',
      forward: '/presentations/#third-secret',
      position: 4,
      replaced: false,
      scroll: { top: 12, left: 0 },
    }
    expect(privateLinkHistoryState(state)).toEqual({
      ...state,
      current: '/presentations',
      back: '/fr/recipient/invitations?view=short',
      forward: '/presentations/',
    })
    expect(state.current).toBe('/presentations#secret')
  })
  it('preserves ordinary anchors and arbitrary non-router state', () => {
    const state = {
      current: '/learn#credentials',
      back: '/other/presentations#anchor',
      forward: null,
      other: 'keep',
    }
    expect(privateLinkHistoryState(state)).toEqual(state)
    expect(privateLinkHistoryState(null)).toBeNull()
  })
})
