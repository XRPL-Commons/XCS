interface DisconnectableClient {
  isConnected(): boolean
  disconnect(): Promise<void>
}

export async function closeWalletRpc(client?: DisconnectableClient): Promise<void> {
  try {
    if (client?.isConnected()) await client.disconnect()
  } catch {
    console.warn('Could not close the wallet operation RPC connection.')
  }
}

/** Cleanup must not replace a transaction result or leave the UI locked. */
export async function finishWalletOperation(
  busy: { value: boolean },
  refreshOperations: () => Promise<unknown>,
  client?: DisconnectableClient,
): Promise<void> {
  try {
    try {
      await refreshOperations()
    } catch {
      console.warn('Could not refresh the wallet operation history.')
    }
    await closeWalletRpc(client)
  } finally {
    busy.value = false
  }
}
