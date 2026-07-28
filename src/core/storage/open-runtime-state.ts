import type { AppConfig } from "../config/schema.js"
import type { RuntimeStateStore, StorageAdapter } from "./contracts.js"
import { FileRuntimeStateStore } from "./file-runtime-state.js"

export interface OpenRuntimeState {
  state: RuntimeStateStore
  dispose(): Promise<void>
}

/**
 * Opens persistent CLI settings without creating a runtime or session store.
 * SQLite is imported only when an existing configuration explicitly selects it.
 */
export async function openRuntimeState(config: AppConfig, cwd: string): Promise<OpenRuntimeState> {
  if (config.storage.kind !== "sqlite") {
    return { state: new FileRuntimeStateStore(cwd), dispose: async () => undefined }
  }

  const { createSqliteAdapter } = await import("../../adapters/sqlite/index.js")
  const adapter: StorageAdapter = createSqliteAdapter()
  const controller = new AbortController()
  const state = await adapter.createRuntimeState?.({ cwd, config, signal: controller.signal })
  if (!state) throw new Error("SQLite adapter did not provide runtime state storage")
  return {
    state,
    dispose: async () => {
      controller.abort()
      await adapter.dispose?.()
    },
  }
}
