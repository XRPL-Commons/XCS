export default defineAppConfig({
  ui: {
    colors: {
      primary: 'sage',
      secondary: 'neutral',
      success: 'success',
      info: 'sage',
      warning: 'warning',
      error: 'error',
      neutral: 'neutral',
    },
    button: {
      slots: { base: 'rounded-[0.45rem] font-semibold' },
      defaultVariants: { color: 'neutral', variant: 'solid' },
      compoundVariants: [
        {
          color: 'neutral',
          variant: 'solid',
          class: 'bg-neutral-950 text-white hover:bg-neutral-800 disabled:bg-neutral-950',
        },
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-white text-neutral-950 ring-neutral-300 hover:bg-neutral-100',
        },
      ],
    },
    card: {
      slots: {
        root: 'rounded-[0.6rem] bg-elevated ring-default shadow-none',
        header: 'p-5 sm:px-6',
        body: 'p-5 sm:p-6',
        footer: 'p-5 sm:px-6',
      },
    },
    badge: { slots: { base: 'rounded-full font-semibold' } },
    alert: { slots: { root: 'rounded-[0.6rem]' } },
    input: { slots: { root: 'w-full' }, defaultVariants: { size: 'lg' } },
    textarea: { slots: { root: 'w-full' }, defaultVariants: { size: 'lg' } },
    select: { slots: { base: 'w-full' }, defaultVariants: { size: 'lg' } },
    formField: { slots: { label: 'font-semibold text-default' } },
    pageHeader: {
      slots: {
        root: 'border-b-0 py-0',
        headline: 'text-xs font-semibold uppercase tracking-[0.2em] text-muted',
        title: 'font-display text-4xl tracking-tight sm:text-5xl',
        description: 'max-w-3xl text-lg text-toned',
      },
    },
    pageCard: { slots: { root: 'rounded-[0.6rem] shadow-none' } },
  },
})
