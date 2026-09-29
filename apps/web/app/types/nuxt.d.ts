import type { Client } from 'xrpl'

declare module '#app' {
  interface NuxtApp {
    $xrplClientFactory: (rpcUrl: string) => Client
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $xrplClientFactory: (rpcUrl: string) => Client
  }
}

export {}
