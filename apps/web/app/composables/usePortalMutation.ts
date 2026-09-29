import { portalProblem, type PortalProblem } from '~/utils/portalProblem'

export function usePortalMutation() {
  const state = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const problem = shallowRef<PortalProblem | null>(null)
  let lastWork: (() => Promise<unknown>) | null = null

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (state.value === 'loading') return undefined
    lastWork = work
    state.value = 'loading'
    problem.value = null
    try {
      const result = await work()
      state.value = 'success'
      return result
    } catch (error) {
      problem.value = portalProblem(error)
      state.value = 'error'
      return undefined
    }
  }

  async function retry(): Promise<void> {
    const work = lastWork
    if (!work || !problem.value?.recoverable) return
    await run(work)
  }

  function reset(): void {
    state.value = 'idle'
    problem.value = null
    lastWork = null
  }

  return {
    state: readonly(state),
    loading: computed(() => state.value === 'loading'),
    problem: readonly(problem),
    run,
    retry,
    reset,
  }
}
