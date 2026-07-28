import type { AppConfig } from "../config/schema.js"
import { FileSessionStore, resolveStorePath } from "../session/file-session-store.js"
import { InMemorySessionStore } from "../session/session-store.js"
import type { RuntimeStateStore, StorageAdapter, StorageContext } from "./contracts.js"
import { FileRuntimeStateStore } from "./file-runtime-state.js"
import { MemoryRuntimeStateStore } from "./runtime-state.js"

export class StorageRegistry {
  private readonly adapters = new Map<string, StorageAdapter>()

  constructor(adapters: StorageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: StorageAdapter): void {
    if (!adapter.id) throw new Error("Storage adapter id must not be empty")
    if (this.adapters.has(adapter.id)) throw new Error(`Storage adapter "${adapter.id}" is already registered`)
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): StorageAdapter | undefined {
    return this.adapters.get(id)
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort()
  }
}

export function createBuiltInStorageAdapters(): StorageAdapter[] {
  return [
    {
      id: "memory",
      createSessionStore: () => new InMemorySessionStore(),
      createRuntimeState: () => new MemoryRuntimeStateStore(),
    },
    {
      id: "file",
      createSessionStore: ({ cwd, config }) =>
        new FileSessionStore(resolveStorePath(cwd, config.storage.path)),
      createRuntimeState: ({ cwd }) => new FileRuntimeStateStore(cwd),
    },
  ]
}

export async function resolveStorageAdapter(
  config: AppConfig,
  injected: StorageAdapter[],
): Promise<StorageAdapter> {
  const registry = new StorageRegistry([...createBuiltInStorageAdapters(), ...injected])
  const existing = registry.get(config.storage.kind)
  if (existing) return existing
  if (config.storage.kind === "sqlite") {
    const { createSqliteAdapter } = await import("../../adapters/sqlite/index.js")
    return createSqliteAdapter()
  }
  throw new Error(
    `Unknown storage adapter "${String(config.storage.kind)}". Available adapters: ${registry.ids().join(", ")}`,
  )
}

export async function createAdapterStores(
  adapter: StorageAdapter,
  context: StorageContext,
): Promise<{ sessions: Awaited<ReturnType<StorageAdapter["createSessionStore"]>>; state: RuntimeStateStore }> {
  if (context.signal.aborted) throw context.signal.reason
  const sessions = await adapter.createSessionStore(context)
  if (context.signal.aborted) throw context.signal.reason
  const state = adapter.createRuntimeState
    ? await adapter.createRuntimeState(context)
    : new MemoryRuntimeStateStore()
  if (context.signal.aborted) throw context.signal.reason
  return { sessions, state }
}
