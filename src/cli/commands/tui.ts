import { createInterface, type Interface } from "node:readline"
import { spawn } from "node:child_process"
import { stdin as defaultInput, stdout as defaultOutput } from "node:process"
import { loadConfig } from "../../core/config/config-loader.js"
import type { AppConfig, ModelCatalogEntry, ModelRef, PartialDeep, ProviderProtocol } from "../../core/config/schema.js"
import { normalizePromptFileMentions } from "../../core/context/file-mentions.js"
import {
  addUserPrompt,
  compactSession,
  createRuntime,
  createSession,
  forkSession,
  switchModel,
  updateSessionMode,
  type Runtime,
} from "../../core/runtime.js"
import { listSessionSnapshots, revertSessionSnapshots } from "../../core/session/file-snapshots.js"
import { createProviderAdapter, listModelCatalog } from "../../core/llm/model-registry.js"
import type { PendingApproval } from "../../core/permissions/approvals.js"
import {
  ansi,
  extractCopyLines,
  getTranscriptScrollMax,
  parseTuiCommand,
  renderCopyModeScreen,
  renderSlashCommandMenu,
  renderConfigSummary,
  renderAssistantPrefix,
  renderConnectPanel,
  renderDiffPanel,
  renderHelp,
  renderHistory,
  renderKeysPanel,
  renderModelPickerMenu,
  renderModelsPanel,
  renderPermissionRequest,
  renderPrompt,
  renderRevertPanel,
  renderRunError,
  renderScreen,
  renderSessionList,
  renderStatusPanel,
  renderSwitchPanel,
  renderToolCall,
  renderToolResult,
  renderToolsPanel,
  slashCommandHints,
  suggestSlashCommands,
  type CopyModeLine,
  type SlashCommandHint,
  type TuiScreenSnapshot,
} from "../tui/render.js"

interface TuiArgs {
  allowShell: boolean
  allowEdit: boolean
  allowNetwork: boolean
  askPermissions: boolean
  approvalTimeoutMs?: number
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  storageKind?: AppConfig["storage"]["kind"]
  storagePath?: string
  sessionId?: string
  cwd?: string
}

export async function tuiCommand(args: string[]): Promise<void> {
  const parsed = parseTuiArgs(args)
  const cwd = parsed.cwd ?? process.cwd()
  let config = await loadConfig({
    cwd,
    overrides: createTuiOverrides(parsed),
  })
  const runtime = createRuntime(config, cwd)
  config = runtime.config
  let currentSession = parsed.sessionId ? runtime.sessions.getSession(parsed.sessionId) : createSession(runtime)
  let activeRunSessionId: string | undefined
  let assistantLineOpen = false
  let streamedAssistantText = false
  let notice: string | undefined
  let pendingApprovals = 0
  let currentPanel: string | undefined
  let redrawAfterRun = false
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let transcriptScrollOffset = 0

  const input = new TuiLineInput({
    onScroll(delta) {
      scrollTranscript(delta)
    },
  })

  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.type === "llm.text_delta" && event.payload.sessionId === activeRunSessionId) {
      if (!assistantLineOpen) {
        defaultOutput.write(renderAssistantPrefix())
        assistantLineOpen = true
      }
      streamedAssistantText = true
      defaultOutput.write(event.payload.text)
    }

    if (event.type === "tool.call" && event.payload.sessionId === activeRunSessionId) {
      if (assistantLineOpen) {
        defaultOutput.write("\n")
        assistantLineOpen = false
      }
      defaultOutput.write(`${renderToolCall(event.payload.toolCall.name, event.payload.toolCall.input)}\n`)
    }

    if (event.type === "permission.requested") {
      pendingApprovals += 1
      void askForPermission(runtime, input, event.payload.approval)
    }

    if (event.type === "permission.resolved") {
      pendingApprovals = Math.max(0, pendingApprovals - 1)
    }
  })

  const redrawForResize = () => {
    if (!defaultOutput.isTTY) return
    if (activeRunSessionId) {
      redrawAfterRun = true
      return
    }

    try {
      currentSession = runtime.sessions.getSession(currentSession.id)
      transcriptScrollOffset = clampTranscriptScrollOffset(transcriptScrollOffset)
      redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel, transcriptScrollOffset)
      if (input.isWaiting()) {
        input.redrawPrompt()
      }
    } catch (error) {
      defaultOutput.write(`${ansi.red}resize redraw failed:${ansi.reset} ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const onResize = () => {
    if (!defaultOutput.isTTY) return
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      redrawForResize()
    }, 80)
  }

  function scrollTranscript(delta: number): void {
    if (!defaultOutput.isTTY || activeRunSessionId || currentPanel) return

    const scrollStep = Math.max(2, Math.min(8, Math.floor(terminalHeight() / 8)))
    const nextOffset = clampTranscriptScrollOffset(transcriptScrollOffset + delta * scrollStep)
    if (nextOffset === transcriptScrollOffset) return

    transcriptScrollOffset = nextOffset
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      currentSession = runtime.sessions.getSession(currentSession.id)
      redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, undefined, transcriptScrollOffset)
      if (input.isWaiting()) {
        input.redrawPrompt()
      }
    }, 16)
  }

  function clampTranscriptScrollOffset(offset: number): number {
    if (currentPanel) return 0
    const maxOffset = getTranscriptScrollMax(
      runtime.sessions.listMessages(currentSession.id),
      terminalWidth(),
      terminalHeight(),
      notice,
    )
    return Math.max(0, Math.min(maxOffset, offset))
  }

  if (defaultOutput.isTTY) {
    defaultOutput.on("resize", onResize)
  }

  try {
    if (defaultOutput.isTTY) {
      defaultOutput.write(`${ansi.enterAlternateScreen}${ansi.enableMouse}${ansi.clearScreen}${ansi.clearScrollback}`)
    }
    redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)

    while (true) {
      const line = await input.question(renderPrompt(currentSession), { slashCommands: slashCommandHints })
      if (line === undefined) break
      const command = parseTuiCommand(line)

      if (command.type === "empty") continue
      if (command.type === "exit") break

      if (command.type === "help") {
        transcriptScrollOffset = 0
        currentPanel = renderHelp(panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        continue
      }

      if (command.type === "new") {
        currentSession = createSession(runtime)
        notice = `Created session ${currentSession.id}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "clear") {
        notice = undefined
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, undefined, transcriptScrollOffset, { hardClear: true })
        continue
      }

      if (command.type === "clear_history") {
        runtime.sessions.clearMessages(currentSession.id)
        currentSession = runtime.sessions.getSession(currentSession.id)
        notice = `Cleared history for ${currentSession.id}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "forget") {
        runtime.sessions.deleteSession(currentSession.id)
        currentSession = createSession(runtime)
        notice = "Deleted previous session and created a new one"
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "sessions") {
        transcriptScrollOffset = 0
        currentPanel = renderSessionList(runtime.sessions.listSessions(), currentSession.id, panelWidth())
        redrawSession(
          config,
          currentSession,
          runtime,
          cwd,
          notice,
          pendingApprovals,
          currentPanel,
        )
        continue
      }

      if (command.type === "use") {
        currentSession = runtime.sessions.getSession(command.sessionId)
        notice = `Using session ${currentSession.id}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "history") {
        transcriptScrollOffset = 0
        currentPanel = renderHistory(runtime.sessions.listMessages(currentSession.id), panelWidth())
        redrawSession(
          config,
          currentSession,
          runtime,
          cwd,
          notice,
          pendingApprovals,
          currentPanel,
        )
        continue
      }

      if (command.type === "status") {
        currentSession = runtime.sessions.getSession(currentSession.id)
        transcriptScrollOffset = 0
        currentPanel = renderStatusPanel(config, currentSession, cwd, pendingApprovals, panelWidth())
        redrawSession(
          config,
          currentSession,
          runtime,
          cwd,
          notice,
          pendingApprovals,
          currentPanel,
        )
        continue
      }

      if (command.type === "config") {
        transcriptScrollOffset = 0
        currentPanel = renderConfigSummary(config, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        continue
      }

      if (command.type === "tools") {
        transcriptScrollOffset = 0
        currentPanel = renderToolsPanel(runtime.tools.list(), panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        continue
      }

      if (command.type === "models") {
        transcriptScrollOffset = 0
        const catalog = listModelCatalog(config)
        if (!defaultInput.isTTY || !defaultOutput.isTTY) {
          currentPanel = renderModelsPanel(catalog, currentSession.model, panelWidth())
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
          continue
        }
        currentPanel = undefined
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        const selectedModel = await input.questionModelPicker("  model: ", catalog, currentSession.model)
        if (selectedModel) {
          try {
            currentSession = switchModel(runtime, currentSession.id, selectedModel)
            notice = `Switched to ${selectedModel.provider}/${selectedModel.model}`
          } catch (error) {
            notice = error instanceof Error ? error.message : String(error)
          }
        }
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "connect") {
        const curProvider = currentSession.model.provider === "mock" ? "openai-compatible" : currentSession.model.provider
        const curModel = currentSession.model.model
        transcriptScrollOffset = 0
        currentPanel = renderConnectPanel({
          provider: curProvider,
          baseUrl: getProviderBaseUrl(config, curProvider),
          model: curModel,
          hasKey: Boolean(getProviderApiKey(config, curProvider) ?? runtime.db?.getApiKey(curProvider)),
        }, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)

        // Step 1: provider
        const providerIn = await input.question(`Provider [${curProvider}]: `)
        if (providerIn === undefined) break
        let providerName = providerIn.trim() || curProvider

        // Step 2: base URL (skipped for pure API-key providers like anthropic / gemini)
        const needsBaseUrl = !["anthropic", "gemini"].includes(providerName)
        let baseUrl = getProviderBaseUrl(config, providerName)
        if (needsBaseUrl) {
          const defaultUrl = baseUrl || "https://api.openai.com/v1/chat/completions"
          const urlIn = await input.question(`Base URL [${defaultUrl}]: `)
          if (urlIn === undefined) break
          baseUrl = urlIn.trim() || defaultUrl
        }
        providerName = maybePromoteOpenAICompatibleConnection(config, providerName, baseUrl)

        // Step 3: API key (enter to keep existing)
        const existingKey = getProviderApiKey(config, providerName) ?? runtime.db?.getApiKey(providerName)
        const keyPrompt = existingKey ? `API key (Enter to keep existing): ` : `API key: `
        const keyIn = await input.question(keyPrompt)
        if (keyIn === undefined) break
        const apiKey = keyIn.trim() || existingKey || ""
        if (!apiKey) {
          notice = "API key is required — connection not changed"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        // Step 4: model
        const modelIn = await input.question(`Model [${curModel}]: `)
        if (modelIn === undefined) break
        const modelId = modelIn.trim() || curModel

        // Step 5: protocol — inferred for known providers, prompted for new custom ones
        const knownBuiltins = new Set(["anthropic", "gemini", "openai-compatible", "openai", "openai-chat"])
        let protocol: ProviderProtocol
        if (knownBuiltins.has(providerName)) {
          protocol = builtinProtocol(providerName)
        } else if (config.providers.custom[providerName]) {
          protocol = config.providers.custom[providerName].protocol
        } else {
          const protoIn = await input.question("Protocol [openai-compatible / anthropic-messages / gemini-generative-language]: ")
          if (protoIn === undefined) break
          const protoVal = protoIn.trim() || "openai-compatible"
          const valid: ProviderProtocol[] = ["mock", "openai-chat", "openai-compatible", "anthropic-messages", "gemini-generative-language"]
          if (!valid.includes(protoVal as ProviderProtocol)) {
            notice = `Unknown protocol: ${protoVal}`
            currentPanel = undefined
            transcriptScrollOffset = 0
            redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
            continue
          }
          protocol = protoVal as ProviderProtocol
        }

        // Step 6: display name (optional)
        const nameIn = await input.question("Display name (optional, Enter to skip): ")
        if (nameIn === undefined) break
        const displayName = nameIn.trim() || undefined

        // Persist to SQLite — key, provider config, model catalog entry, active model
        if (runtime.db) {
          runtime.db.setApiKey(providerName, apiKey)
          runtime.db.setProviderConfig(providerName, {
            baseUrl: baseUrl || getProviderBaseUrl(config, providerName),
            protocol,
            apiKeyEnv: `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`,
          })
          runtime.db.upsertCustomModel({
            provider: providerName,
            model: modelId,
            displayName,
            protocol,
            capabilities: { tools: true, streaming: true, usage: true, reasoning: false, imageInput: false },
          })
          runtime.db.setActiveModel({ provider: providerName, model: modelId })
        }

        // Apply key + base URL to the effective runtime config.
        applyProviderConfig(config, providerName, apiKey, baseUrl, protocol)

        // Update model catalog + runtime snapshot.
        const catalogEntry = {
          provider: providerName, model: modelId, displayName, protocol,
          capabilities: { tools: true, streaming: true, usage: true, reasoning: false, imageInput: false },
        }
        const idx = config.models.catalog.findIndex((e) => e.provider === providerName && e.model === modelId)
        if (idx >= 0) {
          config.models.catalog[idx] = catalogEntry
        } else {
          config.models.catalog = [...config.models.catalog, catalogEntry]
        }
        runtime.models.catalog = listModelCatalog(config)

        // Switch active model
        currentSession = switchModel(runtime, currentSession.id, { provider: providerName, model: modelId })
        notice = `Connected · ${providerName}/${modelId}${runtime.db ? " · saved for all sessions" : ""}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "switch") {
        if (!command.ref) {
          transcriptScrollOffset = 0
          const catalog = listModelCatalog(config)
          if (!defaultInput.isTTY || !defaultOutput.isTTY) {
            currentPanel = renderSwitchPanel(catalog, currentSession.model, panelWidth())
            redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
            continue
          }
          currentPanel = undefined
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          const selectedModel = await input.questionModelPicker("  model: ", catalog, currentSession.model)
          if (selectedModel) {
            try {
              currentSession = switchModel(runtime, currentSession.id, selectedModel)
              notice = `Switched to ${selectedModel.provider}/${selectedModel.model}`
            } catch (error) {
              notice = error instanceof Error ? error.message : String(error)
            }
          }
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        const slashIndex = command.ref.indexOf("/")
        let provider: string
        let modelName: string
        const builtinProviders = new Set(["mock", "openai", "openai-chat", "openai-compatible", "anthropic", "gemini"])
        const knownProviders = new Set([
          ...builtinProviders,
          ...Object.keys(config.providers.custom),
        ])
        if (slashIndex === -1) {
          const exactMatches = listModelCatalog(config).filter((entry) => entry.model === command.ref)
          if (exactMatches.length === 1 && exactMatches[0]) {
            provider = exactMatches[0].provider
            modelName = exactMatches[0].model
          } else {
            provider = currentSession.model.provider === "mock" ? "openai-compatible" : currentSession.model.provider
            modelName = command.ref
          }
        } else if (!knownProviders.has(command.ref.slice(0, slashIndex))) {
          // No slash, or slash is part of the model ID (e.g. "meta-llama/Llama-3")
          provider = currentSession.model.provider === "mock" ? "openai-compatible" : currentSession.model.provider
          modelName = command.ref
        } else {
          provider = command.ref.slice(0, slashIndex)
          modelName = command.ref.slice(slashIndex + 1)
        }

        if (!modelName) {
          notice = `Invalid model ref: ${command.ref}`
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        try {
          currentSession = switchModel(runtime, currentSession.id, { provider, model: modelName })
          notice = `Switched to ${provider}/${modelName}`
        } catch (error) {
          notice = error instanceof Error ? error.message : String(error)
        }
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "diff") {
        transcriptScrollOffset = 0
        currentPanel = renderDiffPanel(await listSessionSnapshots(cwd, currentSession.id), panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        continue
      }

      if (command.type === "revert") {
        const results = await revertSessionSnapshots(cwd, currentSession.id)
        notice = `Reverted ${results.filter((result) => result.reverted).length} of ${results.length} snapshot${results.length === 1 ? "" : "s"}`
        transcriptScrollOffset = 0
        currentPanel = renderRevertPanel(results, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        continue
      }

      if (command.type === "abort") {
        const activeRun = runtime.runs.abort(currentSession.id, undefined, "tui command")
        notice = activeRun ? `Abort requested for ${activeRun.runId}` : "No active run for this session"
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "mode") {
        currentSession = updateSessionMode(runtime, currentSession.id, command.mode)
        notice = `Switched to ${command.mode} mode`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "compact") {
        const result = compactSession(runtime, currentSession.id)
        currentSession = result.session
        notice = `Compacted ${result.removedMessages} message${result.removedMessages === 1 ? "" : "s"}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "fork") {
        currentSession = forkSession(runtime, currentSession.id)
        notice = `Forked into ${currentSession.id}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "copy") {
        const messages = runtime.sessions.listMessages(currentSession.id)
        if (messages.length === 0) {
          notice = "No messages to copy"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }
        if (!defaultInput.isTTY || !defaultOutput.isTTY) {
          notice = "Copy mode requires a TTY"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }
        const snapshot: TuiScreenSnapshot = {
          config,
          session: currentSession,
          messages,
          cwd,
          pendingApprovals,
          width: terminalWidth(),
          height: terminalHeight(),
        }
        const lines = extractCopyLines(messages, panelWidth())
        const text = await input.enterCopyMode(snapshot, lines)
        if (text !== undefined) {
          try {
            await copyToClipboard(text)
            notice = "Copied to clipboard"
          } catch (err) {
            notice = `Copy failed: ${err instanceof Error ? err.message : String(err)}`
          }
        } else {
          notice = undefined
        }
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "keys") {
        transcriptScrollOffset = 0
        const entries = runtime.db ? runtime.db.listApiKeys() : []
        currentPanel = renderKeysPanel(entries, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)
        if (!runtime.db) notice = "API key storage requires sqlite storage (current: " + config.storage.kind + ")"
        continue
      }

      if (command.type === "key_add") {
        if (!runtime.db) {
          notice = "API key storage requires sqlite storage"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }
        const entries = runtime.db.listApiKeys()
        transcriptScrollOffset = 0
        currentPanel = renderKeysPanel(entries, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)

        const providerInput = await input.question("Provider name (anthropic / openai-compatible / gemini / custom): ")
        if (providerInput === undefined) break
        const providerName = providerInput.trim()
        if (!providerName) {
          notice = "Cancelled — no provider entered"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        const apiKeyInput = await input.question(`API key for "${providerName}": `)
        if (apiKeyInput === undefined) break
        const apiKeyValue = apiKeyInput.trim()
        if (!apiKeyValue) {
          notice = "Cancelled — no API key entered"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        runtime.db.setApiKey(providerName, apiKeyValue)

        // Apply immediately so the current session can use the key.
        if (providerName === "anthropic") {
          config.providers.anthropic.apiKey = apiKeyValue
        } else if (providerName === "gemini") {
          config.providers.gemini.apiKey = apiKeyValue
        } else if (config.providers.custom[providerName]) {
          config.providers.custom[providerName].apiKey = apiKeyValue
        } else if (usesSharedOpenAIConfig(config, providerName)) {
          config.providers.openaiCompatible.apiKey = apiKeyValue
        }
        // Refresh the provider adapter so the new key takes effect without restart
        if (keyChangeAffectsActiveProvider(runtime.config, providerName, runtime.config.model.provider)) {
          try {
            runtime.runner.setProvider(createProviderAdapter(runtime.config))
          } catch {
            // provider may not be functional yet — key is saved, will apply on next run
          }
        }

        notice = `API key for "${providerName}" saved`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "key_delete") {
        if (!runtime.db) {
          notice = "API key storage requires sqlite storage"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }
        const entries = runtime.db.listApiKeys()
        transcriptScrollOffset = 0
        currentPanel = renderKeysPanel(entries, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)

        const providerInput = await input.question("Provider to delete key for: ")
        if (providerInput === undefined) break
        const providerName = providerInput.trim()
        if (!providerName) {
          notice = "Cancelled — no provider entered"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        runtime.db.deleteApiKey(providerName)

        // Clear from the effective runtime config.
        if (providerName === "anthropic") {
          config.providers.anthropic.apiKey = undefined
        } else if (providerName === "gemini") {
          config.providers.gemini.apiKey = undefined
        } else if (config.providers.custom[providerName]) {
          config.providers.custom[providerName].apiKey = undefined
        } else if (usesSharedOpenAIConfig(config, providerName)) {
          config.providers.openaiCompatible.apiKey = undefined
        }

        notice = `API key for "${providerName}" deleted`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "model_remove") {
        if (!runtime.db) {
          notice = "Custom model storage requires sqlite storage"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }
        transcriptScrollOffset = 0
        currentPanel = renderModelsPanel(runtime.models.catalog, currentSession.model, panelWidth())
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, currentPanel)

        const refInput = await input.question("Model to remove (provider/model): ")
        if (refInput === undefined) break
        const ref = refInput.trim()
        if (!ref) {
          notice = "Cancelled"
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        const slashIndex = ref.indexOf("/")
        if (slashIndex === -1) {
          notice = `Invalid format — expected provider/model, got: ${ref}`
          currentPanel = undefined
          transcriptScrollOffset = 0
          redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
          continue
        }

        const providerName = ref.slice(0, slashIndex)
        const modelId = ref.slice(slashIndex + 1)
        const removedActiveModel = isSameModel(config.model, { provider: providerName, model: modelId })
        const replacementModel = removedActiveModel
          ? pickReplacementModel(config, { provider: providerName, model: modelId })
          : undefined
        runtime.db.deleteCustomModel(providerName, modelId)

        const filtered = (cat: typeof config.models.catalog) =>
          cat.filter((e) => !(e.provider === providerName && e.model === modelId))
        config.models.catalog = filtered(config.models.catalog)

        if (replacementModel) {
          config.model = replacementModel
          currentSession = switchModel(runtime, currentSession.id, replacementModel)
        }

        runtime.models.catalog = listModelCatalog(config)

        notice = replacementModel
          ? `Model "${providerName}/${modelId}" removed from catalog; switched to ${replacementModel.provider}/${replacementModel.model}`
          : `Model "${providerName}/${modelId}" removed from catalog`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      if (command.type === "unknown") {
        notice = `Unknown command: ${command.input}`
        currentPanel = undefined
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
        continue
      }

      const normalizedPrompt = await normalizePromptFileMentions(cwd, command.prompt)
      addUserPrompt(runtime, currentSession.id, normalizedPrompt.prompt)
      notice = undefined
      if (normalizedPrompt.mentions.length > 0) {
        const inlined = normalizedPrompt.mentions.filter((mention) => mention.status === "inlined").length
        notice = `Attached ${inlined}/${normalizedPrompt.mentions.length} @file mention${normalizedPrompt.mentions.length === 1 ? "" : "s"}`
      }
      currentPanel = undefined
      transcriptScrollOffset = 0
      redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals)
      activeRunSessionId = currentSession.id
      assistantLineOpen = false
      streamedAssistantText = false
      let result
      const activeRun = runtime.runs.start(currentSession.id)
      input.setBackgroundLineHandler((backgroundLine) => {
        const backgroundCommand = parseTuiCommand(backgroundLine)
        if (backgroundCommand.type !== "abort") {
          return false
        }

        const abortedRun = runtime.runs.abort(currentSession.id, activeRun.runId, "tui command")
        notice = abortedRun ? `Abort requested for ${abortedRun.runId}` : "No active run for this session"
        currentPanel = undefined
        transcriptScrollOffset = 0
        if (assistantLineOpen) {
          defaultOutput.write("\n")
          assistantLineOpen = false
        }
        defaultOutput.write(`${notice}\n`)
        return true
      })
      try {
        result = await activeRun.promise
      } catch (error) {
        input.setBackgroundLineHandler(undefined)
        activeRunSessionId = undefined
        assistantLineOpen = false
        streamedAssistantText = false
        currentSession = runtime.sessions.getSession(currentSession.id)
        defaultOutput.write(`\n${renderRunError(error)}\n`)
        continue
      }
      input.setBackgroundLineHandler(undefined)
      currentSession = runtime.sessions.getSession(currentSession.id)
      activeRunSessionId = undefined

      if (assistantLineOpen) {
        defaultOutput.write("\n")
        assistantLineOpen = false
      } else if (!streamedAssistantText && result.assistantText.length > 0) {
        defaultOutput.write(`${renderAssistantPrefix()}${result.assistantText}\n`)
      }

      for (const toolResult of result.toolResults) {
        defaultOutput.write(`${renderToolResult(toolResult)}\n`)
      }

      if (defaultOutput.isTTY) {
        transcriptScrollOffset = 0
        redrawSession(config, currentSession, runtime, cwd, notice, pendingApprovals, undefined, transcriptScrollOffset)
        redrawAfterRun = false
      } else if (redrawAfterRun) {
        redrawAfterRun = false
      } else {
        defaultOutput.write("\n")
      }
    }
  } finally {
    if (resizeTimer) {
      clearTimeout(resizeTimer)
      resizeTimer = undefined
    }
    if (scrollTimer) {
      clearTimeout(scrollTimer)
      scrollTimer = undefined
    }
    if (defaultOutput.isTTY) {
      defaultOutput.off("resize", onResize)
      defaultOutput.write(`${ansi.disableMouse}${ansi.clearScreen}${ansi.exitAlternateScreen}`)
    }
    unsubscribe()
    input.close()
    defaultOutput.write(`${ansi.dim}bye${ansi.reset}\n`)
    if (defaultInput.isTTY) {
      setImmediate(() => process.exit(process.exitCode ?? 0))
    }
  }
}

interface LineQuestionOptions {
  slashCommands?: SlashCommandHint[]
}

interface TuiLineInputOptions {
  onScroll?(delta: number): void
}

interface ActiveQuestion {
  prompt: string
  value: string
  cursor: number
  selectedIndex: number
  options: LineQuestionOptions
  resolve(line: string | undefined): void
}

interface ActivePicker {
  prompt: string
  catalog: ModelCatalogEntry[]
  activeModel: ModelRef
  query: string
  selectedIndex: number
  resolve(ref: ModelRef | undefined): void
}

interface ActiveCopyMode {
  snapshot: TuiScreenSnapshot
  lines: CopyModeLine[]
  cursor: number
  selectionStart: number | undefined
  viewOffset: number
  resolve(text: string | undefined): void
}

interface ParsedKeypress {
  sequence: string
  name?: string
  ctrl?: boolean
  mouseX?: number
  mouseY?: number
  mousePress?: boolean
}

class TuiLineInput {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string | undefined) => void> = []
  private readonly tty = Boolean(defaultInput.isTTY && defaultOutput.isTTY)
  private readonly onDataBound = (chunk: Buffer | string) => {
    this.onData(chunk)
  }
  private readonly previousRawMode: boolean
  private readonly wasPaused: boolean
  private readonly rl?: Interface
  private active: ActiveQuestion | undefined
  private backgroundLineHandler: ((line: string) => boolean) | undefined
  private backgroundValue = ""
  private closed = false
  private disposed = false
  private activePicker: ActivePicker | undefined
  private activeCopyMode: ActiveCopyMode | undefined
  private mouseDragStart: { x: number; y: number } | undefined
  private readonly history: string[] = []
  private historyIndex = -1
  private historySavedValue = ""

  constructor(private readonly options: TuiLineInputOptions = {}) {
    const ttyInput = defaultInput as typeof defaultInput & {
      isRaw?: boolean
      isPaused?: () => boolean
      setRawMode?: (mode: boolean) => void
    }
    this.previousRawMode = Boolean(ttyInput.isRaw)
    this.wasPaused = ttyInput.isPaused?.() ?? true

    if (this.tty) {
      ttyInput.setRawMode?.(true)
      defaultInput.resume()
      defaultInput.on("data", this.onDataBound)
      return
    }

    this.rl = createInterface({
      input: defaultInput,
      output: defaultOutput,
      terminal: false,
    })
    this.rl.on("line", (line) => this.push(line))
    this.rl.on("close", () => this.finish())
  }

  question(prompt: string, options: LineQuestionOptions = {}): Promise<string | undefined> {
    if (this.tty) {
      return this.questionTty(prompt, options)
    }

    defaultOutput.write(defaultInput.isTTY ? prompt : `${prompt}\n`)
    const line = this.lines.shift()
    if (line !== undefined) {
      return Promise.resolve(line)
    }
    if (this.closed) {
      return Promise.resolve(undefined)
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  isWaiting(): boolean {
    return Boolean(this.active) || Boolean(this.activePicker) || Boolean(this.activeCopyMode) || this.waiters.length > 0
  }

  redrawPrompt(): void {
    if (this.activeCopyMode) {
      this.renderActiveCopyMode(this.activeCopyMode)
      return
    }
    if (this.activePicker) {
      this.renderActivePicker(this.activePicker)
      return
    }
    if (!this.active) return
    this.renderActive()
  }

  setBackgroundLineHandler(handler: ((line: string) => boolean) | undefined): void {
    this.backgroundLineHandler = handler
    this.backgroundValue = ""
    if (!handler) return

    const pending = this.lines.splice(0)
    for (const line of pending) {
      if (!handler(line)) {
        this.lines.push(line)
      }
    }
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true

    if (this.activeCopyMode) {
      const copy = this.activeCopyMode
      this.activeCopyMode = undefined
      copy.resolve(undefined)
    }

    if (this.activePicker) {
      const picker = this.activePicker
      this.activePicker = undefined
      picker.resolve(undefined)
    }

    if (this.tty) {
      defaultInput.off("data", this.onDataBound)
      const ttyInput = defaultInput as typeof defaultInput & { setRawMode?: (mode: boolean) => void }
      ttyInput.setRawMode?.(this.previousRawMode)
      if (this.wasPaused) {
        defaultInput.pause()
      }
      this.finish()
      return
    }

    this.rl?.close()
  }

  private questionTty(prompt: string, options: LineQuestionOptions): Promise<string | undefined> {
    if (this.closed) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      this.active = {
        prompt,
        value: "",
        cursor: 0,
        selectedIndex: 0,
        options,
        resolve,
      }
      this.renderActive()
    })
  }

  private onData(chunk: Buffer | string): void {
    for (const keypress of parseKeypresses(chunk)) {
      this.onKeypress(keypress.sequence, keypress)
      if (this.closed) return
    }
  }

  private onKeypress(sequence: string, key: ParsedKeypress): void {
    if (key.name === "mouse_scroll_up") {
      this.options.onScroll?.(1)
      return
    }

    if (key.name === "mouse_scroll_down") {
      this.options.onScroll?.(-1)
      return
    }

    if (key.name === "mouse_left") {
      if (key.mousePress) {
        this.mouseDragStart = { x: key.mouseX!, y: key.mouseY! }
      } else if (this.mouseDragStart) {
        this.handleMouseDragEnd(key.mouseX!, key.mouseY!)
      }
      return
    }

    if (key.name === "mouse") {
      return
    }

    if (this.activePicker) {
      this.onPickerKeypress(sequence, key, this.activePicker)
      return
    }

    if (this.activeCopyMode) {
      this.onCopyModeKeypress(sequence, key, this.activeCopyMode)
      return
    }

    const active = this.active
    if (!active) {
      this.onBackgroundKeypress(sequence, key)
      return
    }

    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      this.resolveActive(undefined)
      this.finish()
      return
    }

    if (key.name === "return" || key.name === "enter") {
      if (this.completeSuggestionOnEnter()) {
        return
      }
      this.resolveActive(active.value)
      return
    }

    if (key.name === "tab") {
      this.acceptSuggestion()
      return
    }

    if (key.name === "up") {
      const hasSuggestions =
        active.options.slashCommands !== undefined &&
        suggestSlashCommands(active.value, active.options.slashCommands).length > 0
      if (hasSuggestions) {
        this.moveSuggestion(-1)
      } else {
        this.navigateHistory(-1)
      }
      return
    }

    if (key.name === "down") {
      const hasSuggestions =
        active.options.slashCommands !== undefined &&
        suggestSlashCommands(active.value, active.options.slashCommands).length > 0
      if (hasSuggestions) {
        this.moveSuggestion(1)
      } else {
        this.navigateHistory(1)
      }
      return
    }

    if (key.name === "page_up") {
      this.options.onScroll?.(4)
      return
    }

    if (key.name === "page_down") {
      this.options.onScroll?.(-4)
      return
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      active.cursor = 0
      this.renderActive()
      return
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      active.cursor = active.value.length
      this.renderActive()
      return
    }

    if (key.ctrl && key.name === "k") {
      active.value = active.value.slice(0, active.cursor)
      active.selectedIndex = 0
      this.historyIndex = -1
      this.renderActive()
      return
    }

    if (key.ctrl && key.name === "u") {
      active.value = active.value.slice(active.cursor)
      active.cursor = 0
      active.selectedIndex = 0
      this.historyIndex = -1
      this.renderActive()
      return
    }

    if (key.ctrl && key.name === "w") {
      this.killWordBackward()
      return
    }

    if (key.name === "ctrl_left") {
      this.moveWordBackward()
      return
    }

    if (key.name === "ctrl_right") {
      this.moveWordForward()
      return
    }

    if (key.name === "left") {
      active.cursor = Math.max(0, active.cursor - 1)
      this.renderActive()
      return
    }

    if (key.name === "right") {
      active.cursor = Math.min(active.value.length, active.cursor + 1)
      this.renderActive()
      return
    }

    if (key.name === "backspace") {
      if (active.cursor > 0) {
        active.value = `${active.value.slice(0, active.cursor - 1)}${active.value.slice(active.cursor)}`
        active.cursor -= 1
        active.selectedIndex = 0
        this.historyIndex = -1
      }
      this.renderActive()
      return
    }

    if (key.name === "delete") {
      if (active.cursor < active.value.length) {
        active.value = `${active.value.slice(0, active.cursor)}${active.value.slice(active.cursor + 1)}`
        active.selectedIndex = 0
        this.historyIndex = -1
      }
      this.renderActive()
      return
    }

    if (sequence && sequence >= " " && sequence !== "\x7f") {
      active.value = `${active.value.slice(0, active.cursor)}${sequence}${active.value.slice(active.cursor)}`
      active.cursor += sequence.length
      active.selectedIndex = 0
      this.historyIndex = -1
      this.renderActive()
    }
  }

  private navigateHistory(delta: number): void {
    const active = this.active
    if (!active || this.history.length === 0) return

    if (this.historyIndex === -1) {
      if (delta < 0) {
        this.historySavedValue = active.value
        this.historyIndex = this.history.length - 1
      } else {
        return
      }
    } else {
      const next = this.historyIndex + delta
      if (next < 0) return
      if (next >= this.history.length) {
        this.historyIndex = -1
        active.value = this.historySavedValue
        active.cursor = active.value.length
        active.selectedIndex = 0
        this.renderActive()
        return
      }
      this.historyIndex = next
    }

    active.value = this.history[this.historyIndex] ?? ""
    active.cursor = active.value.length
    active.selectedIndex = 0
    this.renderActive()
  }

  private killWordBackward(): void {
    const active = this.active
    if (!active || active.cursor === 0) return
    let pos = active.cursor
    while (pos > 0 && active.value[pos - 1] === " ") pos--
    while (pos > 0 && active.value[pos - 1] !== " ") pos--
    active.value = active.value.slice(0, pos) + active.value.slice(active.cursor)
    active.cursor = pos
    active.selectedIndex = 0
    this.historyIndex = -1
    this.renderActive()
  }

  private moveWordBackward(): void {
    const active = this.active
    if (!active) return
    let pos = active.cursor
    while (pos > 0 && active.value[pos - 1] === " ") pos--
    while (pos > 0 && active.value[pos - 1] !== " ") pos--
    active.cursor = pos
    this.renderActive()
  }

  private moveWordForward(): void {
    const active = this.active
    if (!active) return
    let pos = active.cursor
    while (pos < active.value.length && active.value[pos] === " ") pos++
    while (pos < active.value.length && active.value[pos] !== " ") pos++
    active.cursor = pos
    this.renderActive()
  }

  private onBackgroundKeypress(sequence: string, key: ParsedKeypress): void {
    if (key.ctrl && key.name === "c") {
      if (this.backgroundLineHandler?.("/abort")) {
        return
      }
      this.finish()
      return
    }

    if (key.ctrl && key.name === "d") {
      this.finish()
      return
    }

    if (!this.backgroundLineHandler) {
      return
    }

    if (key.name === "return" || key.name === "enter") {
      const line = this.backgroundValue
      this.backgroundValue = ""
      if (line.length > 0 && !this.backgroundLineHandler(line)) {
        this.lines.push(line)
      }
      return
    }

    if (key.name === "backspace") {
      this.backgroundValue = this.backgroundValue.slice(0, -1)
      return
    }

    if (sequence && sequence >= " " && sequence !== "\x7f") {
      this.backgroundValue += sequence
    }
  }

  private acceptSuggestion(): void {
    const active = this.active
    if (!active?.options.slashCommands) return
    const suggestions = suggestSlashCommands(active.value, active.options.slashCommands)
    const suggestion = suggestions[active.selectedIndex]
    if (!suggestion) return
    active.value = suggestion.insert
    active.cursor = active.value.length
    active.selectedIndex = 0
    this.renderActive()
  }

  private completeSuggestionOnEnter(): boolean {
    const active = this.active
    if (!active?.options.slashCommands) return false

    const suggestions = suggestSlashCommands(active.value, active.options.slashCommands)
    const suggestion = suggestions[active.selectedIndex]
    if (!suggestion) return false

    const current = active.value.trim()
    const inserted = suggestion.insert.trim()
    if (current === inserted && !suggestion.insert.endsWith(" ")) {
      return false
    }

    active.value = suggestion.insert
    active.cursor = active.value.length
    active.selectedIndex = 0
    this.renderActive()
    return true
  }

  private moveSuggestion(delta: number): void {
    const active = this.active
    if (!active?.options.slashCommands) return
    const suggestions = suggestSlashCommands(active.value, active.options.slashCommands)
    if (suggestions.length === 0) return
    active.selectedIndex = (active.selectedIndex + delta + suggestions.length) % suggestions.length
    this.renderActive()
  }

  private resolveActive(line: string | undefined): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    this.historyIndex = -1
    this.historySavedValue = ""
    if (line !== undefined && line.trim().length > 0) {
      if (this.history[this.history.length - 1] !== line) {
        this.history.push(line)
      }
    }
    defaultOutput.write("\r\x1b[J")
    if (line !== undefined) {
      defaultOutput.write(`${active.prompt}${line}\n`)
    }
    active.resolve(line)
  }

  private renderActive(): void {
    const active = this.active
    if (!active) return
    const suggestions = active.options.slashCommands ? renderSlashCommandMenu(active.value, active.selectedIndex, menuWidth()) : []
    const cursorColumn = visibleLength(`${active.prompt}${active.value.slice(0, active.cursor)}`)

    defaultOutput.write("\r\x1b[J")
    defaultOutput.write(`${active.prompt}${active.value}`)
    for (const line of suggestions) {
      defaultOutput.write(`\n${line}`)
    }
    if (suggestions.length > 0) {
      defaultOutput.write(`\x1b[${suggestions.length}A`)
    }
    defaultOutput.write(`\r${cursorColumn > 0 ? `\x1b[${cursorColumn}C` : ""}`)
  }

  questionModelPicker(
    prompt: string,
    catalog: ModelCatalogEntry[],
    activeModel: ModelRef,
  ): Promise<ModelRef | undefined> {
    if (!this.tty || this.closed) return Promise.resolve(undefined)

    const initialIndex = Math.max(
      0,
      catalog.findIndex((e) => e.provider === activeModel.provider && e.model === activeModel.model),
    )

    return new Promise((resolve) => {
      this.activePicker = { prompt, catalog, activeModel, query: "", selectedIndex: initialIndex, resolve }
      this.renderActivePicker(this.activePicker)
    })
  }

  private onPickerKeypress(sequence: string, key: ParsedKeypress, picker: ActivePicker): void {
    if (key.ctrl && (key.name === "c" || key.name === "d")) {
      this.resolveActivePicker(undefined, picker)
      this.finish()
      return
    }

    if (key.name === "escape") {
      this.resolveActivePicker(undefined, picker)
      return
    }

    if (key.name === "return" || key.name === "enter") {
      const filtered = filterModelCatalog(picker.catalog, picker.query)
      const entry = filtered[picker.selectedIndex]
      this.resolveActivePicker(entry ? { provider: entry.provider, model: entry.model } : undefined, picker)
      return
    }

    if (key.name === "up") {
      const filtered = filterModelCatalog(picker.catalog, picker.query)
      if (filtered.length > 0) {
        picker.selectedIndex = (picker.selectedIndex - 1 + filtered.length) % filtered.length
      }
      this.renderActivePicker(picker)
      return
    }

    if (key.name === "down") {
      const filtered = filterModelCatalog(picker.catalog, picker.query)
      if (filtered.length > 0) {
        picker.selectedIndex = (picker.selectedIndex + 1) % filtered.length
      }
      this.renderActivePicker(picker)
      return
    }

    if (key.name === "backspace") {
      picker.query = picker.query.slice(0, -1)
      picker.selectedIndex = 0
      this.renderActivePicker(picker)
      return
    }

    if (sequence && sequence >= " " && sequence !== "\x7f") {
      picker.query += sequence
      picker.selectedIndex = 0
      this.renderActivePicker(picker)
    }
  }

  private renderActivePicker(picker: ActivePicker): void {
    const menuLines = renderModelPickerMenu(picker.catalog, picker.activeModel, picker.query, picker.selectedIndex, menuWidth())
    const promptLine = `${picker.prompt}${picker.query}`
    const cursorColumn = visibleLength(promptLine)

    defaultOutput.write("\r\x1b[J")
    defaultOutput.write(promptLine)
    for (const line of menuLines) {
      defaultOutput.write(`\n${line}`)
    }
    if (menuLines.length > 0) {
      defaultOutput.write(`\x1b[${menuLines.length}A`)
    }
    defaultOutput.write(`\r${cursorColumn > 0 ? `\x1b[${cursorColumn}C` : ""}`)
  }

  private resolveActivePicker(ref: ModelRef | undefined, picker: ActivePicker): void {
    if (this.activePicker !== picker) return
    this.activePicker = undefined
    defaultOutput.write("\r\x1b[J")
    if (ref !== undefined) {
      defaultOutput.write(`${picker.prompt}${ref.provider}/${ref.model}\n`)
    }
    picker.resolve(ref)
  }

  enterCopyMode(snapshot: TuiScreenSnapshot, lines: CopyModeLine[]): Promise<string | undefined> {
    if (!this.tty || this.closed) return Promise.resolve(undefined)
    const height = Math.max(20, Math.min(defaultOutput.rows || 32, 80))
    const bodyHeight = Math.max(8, height - 8)
    const initialCursor = Math.max(0, lines.length - 1)
    const initialOffset = Math.max(0, initialCursor - bodyHeight + 1)
    return new Promise((resolve) => {
      this.activeCopyMode = { snapshot, lines, cursor: initialCursor, selectionStart: undefined, viewOffset: initialOffset, resolve }
      this.renderActiveCopyMode(this.activeCopyMode)
    })
  }

  private onCopyModeKeypress(sequence: string, key: ParsedKeypress, copyMode: ActiveCopyMode): void {
    if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape" || sequence === "q") {
      this.resolveActiveCopyMode(undefined, copyMode)
      return
    }

    if (key.name === "return" || key.name === "enter" || sequence === "y") {
      const selMin = copyMode.selectionStart !== undefined ? Math.min(copyMode.selectionStart, copyMode.cursor) : copyMode.cursor
      const selMax = copyMode.selectionStart !== undefined ? Math.max(copyMode.selectionStart, copyMode.cursor) : copyMode.cursor
      const text = copyMode.lines.slice(selMin, selMax + 1).map((l) => l.plain).join("\n")
      this.resolveActiveCopyMode(text, copyMode)
      return
    }

    if (sequence === "v" || sequence === " ") {
      copyMode.selectionStart = copyMode.selectionStart !== undefined ? undefined : copyMode.cursor
      this.renderActiveCopyMode(copyMode)
      return
    }

    const height = Math.max(20, Math.min(defaultOutput.rows || 32, 80))
    const bodyHeight = Math.max(8, height - 8)

    if (key.name === "up" || sequence === "k") {
      copyMode.cursor = Math.max(0, copyMode.cursor - 1)
      if (copyMode.cursor < copyMode.viewOffset) copyMode.viewOffset = copyMode.cursor
      this.renderActiveCopyMode(copyMode)
      return
    }

    if (key.name === "down" || sequence === "j") {
      if (copyMode.lines.length > 0) copyMode.cursor = Math.min(copyMode.lines.length - 1, copyMode.cursor + 1)
      if (copyMode.cursor >= copyMode.viewOffset + bodyHeight) copyMode.viewOffset = copyMode.cursor - bodyHeight + 1
      this.renderActiveCopyMode(copyMode)
      return
    }

    if (key.name === "page_up") {
      copyMode.cursor = Math.max(0, copyMode.cursor - bodyHeight)
      copyMode.viewOffset = Math.max(0, copyMode.viewOffset - bodyHeight)
      this.renderActiveCopyMode(copyMode)
      return
    }

    if (key.name === "page_down") {
      if (copyMode.lines.length > 0) {
        copyMode.cursor = Math.min(copyMode.lines.length - 1, copyMode.cursor + bodyHeight)
        const maxOffset = Math.max(0, copyMode.lines.length - bodyHeight)
        copyMode.viewOffset = Math.min(maxOffset, copyMode.viewOffset + bodyHeight)
      }
      this.renderActiveCopyMode(copyMode)
      return
    }

    if (key.name === "home") {
      copyMode.cursor = 0
      copyMode.viewOffset = 0
      this.renderActiveCopyMode(copyMode)
      return
    }

    if (key.name === "end") {
      if (copyMode.lines.length > 0) {
        copyMode.cursor = copyMode.lines.length - 1
        const maxOffset = Math.max(0, copyMode.lines.length - bodyHeight)
        copyMode.viewOffset = maxOffset
      }
      this.renderActiveCopyMode(copyMode)
      return
    }
  }

  private renderActiveCopyMode(copyMode: ActiveCopyMode): void {
    const width = Math.max(72, defaultOutput.columns || 96)
    const height = Math.max(20, Math.min(defaultOutput.rows || 32, 80))
    const screen = renderCopyModeScreen(
      { ...copyMode.snapshot, width, height },
      copyMode.lines,
      copyMode.cursor,
      copyMode.selectionStart,
      copyMode.viewOffset,
    )
    redraw(screen)
  }

  private handleMouseDragEnd(endX: number, endY: number): void {
    const start = this.mouseDragStart
    this.mouseDragStart = undefined
    if (!start || (start.x === endX && start.y === endY)) return
    const text = extractScreenText(lastScreenBuffer, start, { x: endX, y: endY })
    if (!text.trim()) return
    copyToClipboard(text).catch(() => {})
  }

  private resolveActiveCopyMode(text: string | undefined, copyMode: ActiveCopyMode): void {
    if (this.activeCopyMode !== copyMode) return
    this.activeCopyMode = undefined
    copyMode.resolve(text)
  }

  private push(line: string): void {
    if (this.backgroundLineHandler?.(line)) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(line)
      return
    }

    this.lines.push(line)
  }

  private finish(): void {
    this.closed = true
    if (this.activePicker) {
      const picker = this.activePicker
      this.activePicker = undefined
      picker.resolve(undefined)
    }
    if (this.active) {
      const active = this.active
      this.active = undefined
      active.resolve(undefined)
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(undefined)
    }
  }
}

function parseKeypresses(chunk: Buffer | string): ParsedKeypress[] {
  const input = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
  const keys: ParsedKeypress[] = []

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ""
    const next = input.slice(index)

    const sgrMouse = parseSgrMouse(next)
    if (sgrMouse) {
      keys.push(sgrMouse.key)
      index += sgrMouse.length - 1
      continue
    }

    const legacyMouse = parseLegacyMouse(input, index)
    if (legacyMouse) {
      keys.push(legacyMouse.key)
      index += legacyMouse.length - 1
      continue
    }

    // Ctrl+Arrow: check 6-char sequences before shorter ones
    if (next.startsWith("\x1b[1;5C")) {
      keys.push({ sequence: "\x1b[1;5C", name: "ctrl_right" })
      index += 5
      continue
    }
    if (next.startsWith("\x1b[1;5D")) {
      keys.push({ sequence: "\x1b[1;5D", name: "ctrl_left" })
      index += 5
      continue
    }
    // Page Up / Page Down
    if (next.startsWith("\x1b[5~")) {
      keys.push({ sequence: "\x1b[5~", name: "page_up" })
      index += 3
      continue
    }
    if (next.startsWith("\x1b[6~")) {
      keys.push({ sequence: "\x1b[6~", name: "page_down" })
      index += 3
      continue
    }
    // Home — must come after \x1b[1;5C/D checks
    if (next.startsWith("\x1b[1~") || next.startsWith("\x1b[7~")) {
      keys.push({ sequence: next.slice(0, 4), name: "home" })
      index += 3
      continue
    }
    // End
    if (next.startsWith("\x1b[4~") || next.startsWith("\x1b[8~")) {
      keys.push({ sequence: next.slice(0, 4), name: "end" })
      index += 3
      continue
    }
    // Delete
    if (next.startsWith("\x1b[3~")) {
      keys.push({ sequence: "\x1b[3~", name: "delete" })
      index += 3
      continue
    }
    // Arrow keys
    if (next.startsWith("\x1b[A")) {
      keys.push({ sequence: "\x1b[A", name: "up" })
      index += 2
      continue
    }
    if (next.startsWith("\x1b[B")) {
      keys.push({ sequence: "\x1b[B", name: "down" })
      index += 2
      continue
    }
    if (next.startsWith("\x1b[C")) {
      keys.push({ sequence: "\x1b[C", name: "right" })
      index += 2
      continue
    }
    if (next.startsWith("\x1b[D")) {
      keys.push({ sequence: "\x1b[D", name: "left" })
      index += 2
      continue
    }
    // Home/End in application cursor mode or VT100 form
    if (next.startsWith("\x1b[H") || next.startsWith("\x1bOH")) {
      keys.push({ sequence: next.slice(0, 3), name: "home" })
      index += 2
      continue
    }
    if (next.startsWith("\x1b[F") || next.startsWith("\x1bOF")) {
      keys.push({ sequence: next.slice(0, 3), name: "end" })
      index += 2
      continue
    }

    if (char === "\r" || char === "\n") {
      keys.push({ sequence: char, name: "return" })
      continue
    }
    if (char === "\t") {
      keys.push({ sequence: char, name: "tab" })
      continue
    }
    if (char === "\x7f" || char === "\b") {
      keys.push({ sequence: char, name: "backspace" })
      continue
    }
    if (char === "\x01") {
      keys.push({ sequence: char, name: "a", ctrl: true })
      continue
    }
    if (char === "\x03") {
      keys.push({ sequence: char, name: "c", ctrl: true })
      continue
    }
    if (char === "\x04") {
      keys.push({ sequence: char, name: "d", ctrl: true })
      continue
    }
    if (char === "\x05") {
      keys.push({ sequence: char, name: "e", ctrl: true })
      continue
    }
    if (char === "\x0b") {
      keys.push({ sequence: char, name: "k", ctrl: true })
      continue
    }
    if (char === "\x15") {
      keys.push({ sequence: char, name: "u", ctrl: true })
      continue
    }
    if (char === "\x17") {
      keys.push({ sequence: char, name: "w", ctrl: true })
      continue
    }
    if (char === "\x1b") {
      keys.push({ sequence: char, name: "escape" })
      continue
    }

    keys.push({ sequence: char })
  }

  return keys
}

function parseSgrMouse(input: string): { key: ParsedKeypress; length: number } | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(input)
  if (!match) return undefined

  const button = Number(match[1])
  const col = Number(match[2])
  const row = Number(match[3])
  const pressed = match[4] === "M"

  if (button === 0) {
    return {
      key: { sequence: match[0], name: "mouse_left", mouseX: col, mouseY: row, mousePress: pressed },
      length: match[0].length,
    }
  }

  return {
    key: mouseKeypress(match[0], button, pressed),
    length: match[0].length,
  }
}

function parseLegacyMouse(input: string, index: number): { key: ParsedKeypress; length: number } | undefined {
  if (!input.startsWith("\x1b[M", index) || input.length < index + 6) return undefined

  const sequence = input.slice(index, index + 6)
  const button = sequence.charCodeAt(3) - 32
  return {
    key: mouseKeypress(sequence, button, true),
    length: sequence.length,
  }
}

function mouseKeypress(sequence: string, button: number, pressed: boolean): ParsedKeypress {
  if (pressed && (button & 64) === 64) {
    return {
      sequence,
      name: (button & 1) === 0 ? "mouse_scroll_up" : "mouse_scroll_down",
    }
  }

  return { sequence, name: "mouse" }
}

async function askForPermission(runtime: Runtime, input: TuiLineInput, approval: PendingApproval): Promise<void> {
  try {
    defaultOutput.write(`\n${renderPermissionRequest(approval)}\n`)
    const answer = await input.question(
      `${ansi.bold}Allow?${ansi.reset} [y] once, [a] always, [N] deny `,
    )
    if (answer === undefined) {
      runtime.approvals.respond(approval.id, "deny")
      return
    }
    const decision = answer.trim().toLowerCase()
    if (decision === "/abort") {
      runtime.approvals.respond(approval.id, "deny")
      runtime.runs.abort(approval.request.sessionId, undefined, "tui command")
      return
    }
    if (decision === "a" || decision === "always") {
      runtime.approvals.respond(approval.id, "always")
      return
    }
    runtime.approvals.respond(
      approval.id,
      decision === "y" || decision === "yes" || decision === "allow" || decision === "once" ? "once" : "deny",
    )
  } catch (error) {
    defaultOutput.write(`${ansi.red}permission response failed:${ansi.reset} ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function redrawSession(
  config: AppConfig,
  currentSession: ReturnType<Runtime["sessions"]["getSession"]>,
  runtime: Runtime,
  cwd: string,
  notice: string | undefined,
  pendingApprovals: number,
  panel?: string,
  scrollOffset = 0,
  options: RedrawOptions = {},
): void {
  redraw(renderScreen({
    config,
    session: currentSession,
    messages: runtime.sessions.listMessages(currentSession.id),
    cwd,
    notice,
    pendingApprovals,
    panel,
    scrollOffset,
    width: terminalWidth(),
    height: terminalHeight(),
  }), options)
}

let lastScreenBuffer: string[] = []

interface RedrawOptions {
  hardClear?: boolean
}

function redraw(content: string, options: RedrawOptions = {}): void {
  if (defaultOutput.isTTY) {
    // Synchronized output: terminal buffers until end marker — no mid-frame flash.
    // Cursor-home + overwrite + erase-tail avoids clearing the screen to blank first.
    const clear = options.hardClear ? `${ansi.clearScreen}${ansi.clearScrollback}` : ""
    defaultOutput.write(`\x1b[?2026h${clear}\x1b[H${frameForTerminal(content)}\n\n\x1b[J\x1b[?2026l`)
  } else {
    defaultOutput.write(`${content}\n\n`)
  }
  lastScreenBuffer = content.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
}

function frameForTerminal(content: string): string {
  return content.split("\n").map((line) => `${line}\x1b[K`).join("\n")
}

function terminalWidth(): number {
  return Math.max(72, defaultOutput.columns || 96)
}

function terminalHeight(): number {
  return Math.max(20, Math.min(defaultOutput.rows || 32, 80))
}

function panelWidth(): number {
  const width = terminalWidth()
  const sidebarWidth = width >= 88 ? Math.min(36, Math.max(30, Math.floor(width * 0.34))) : 0
  const contentWidth = sidebarWidth > 0 ? width - sidebarWidth - 2 : width
  return Math.max(48, Math.min(contentWidth, 110))
}

function menuWidth(): number {
  const width = terminalWidth()
  const sidebarWidth = width >= 88 ? Math.min(36, Math.max(30, Math.floor(width * 0.34))) : 0
  const contentWidth = sidebarWidth > 0 ? width - sidebarWidth - 2 : width
  return Math.max(36, Math.min(contentWidth, 72))
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length
}

function parseTuiArgs(args: string[]): TuiArgs {
  const parsed: TuiArgs = {
    allowShell: false,
    allowEdit: false,
    allowNetwork: false,
    askPermissions: true,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--allow-shell") {
      parsed.allowShell = true
      continue
    }
    if (arg === "--allow-edit") {
      parsed.allowEdit = true
      continue
    }
    if (arg === "--allow-network") {
      parsed.allowNetwork = true
      continue
    }
    if (arg === "--no-ask-permissions") {
      parsed.askPermissions = false
      continue
    }
    if (arg === "--ask-permissions") {
      parsed.askPermissions = true
      continue
    }
    if (arg === "--approval-timeout-ms") {
      parsed.approvalTimeoutMs = readPositiveInt(args[++index], "--approval-timeout-ms")
      continue
    }
    if (arg === "--provider") {
      parsed.provider = readValue(args[++index], "--provider")
      continue
    }
    if (arg === "--model") {
      parsed.model = readValue(args[++index], "--model")
      continue
    }
    if (arg === "--base-url") {
      parsed.baseUrl = readValue(args[++index], "--base-url")
      continue
    }
    if (arg === "--api-key") {
      parsed.apiKey = readValue(args[++index], "--api-key")
      continue
    }
    if (arg === "--api-key-env") {
      parsed.apiKeyEnv = readValue(args[++index], "--api-key-env")
      continue
    }
    if (arg === "--storage") {
      const value = readValue(args[++index], "--storage")
      if (value !== "memory" && value !== "file" && value !== "sqlite") throw new Error("--storage must be memory, file, or sqlite")
      parsed.storageKind = value
      continue
    }
    if (arg === "--storage-path") {
      parsed.storagePath = readValue(args[++index], "--storage-path")
      continue
    }
    if (arg === "--session") {
      parsed.sessionId = readValue(args[++index], "--session")
      continue
    }

    if (arg === "--cwd") {
      parsed.cwd = readValue(args[++index], "--cwd")
      continue
    }

    throw new Error(`Unknown tui argument: ${arg}`)
  }

  return parsed
}

function createTuiOverrides(args: TuiArgs): PartialDeep<AppConfig> {
  const overrides: PartialDeep<AppConfig> = {
    permissions: {
      askForShell: args.askPermissions,
      askForEdit: args.askPermissions,
      askForNetwork: args.askPermissions,
    },
  }

  if (args.allowShell) overrides.permissions = { ...overrides.permissions, allowShell: true }
  if (args.allowEdit) overrides.permissions = { ...overrides.permissions, allowEdit: true }
  if (args.allowNetwork) overrides.permissions = { ...overrides.permissions, allowNetwork: true }
  if (args.approvalTimeoutMs !== undefined) {
    overrides.permissions = { ...overrides.permissions, approvalTimeoutMs: args.approvalTimeoutMs }
  }

  if (args.provider || args.model) {
    const model: Partial<AppConfig["model"]> = {}
    if (args.provider) model.provider = args.provider
    if (args.model) model.model = args.model
    overrides.model = model
  }

  if (args.baseUrl || args.apiKey || args.apiKeyEnv) {
    overrides.providers = createProviderOverrides(args)
  }

  if (args.storageKind || args.storagePath) {
    const storage: Partial<AppConfig["storage"]> = {}
    if (args.storageKind) storage.kind = args.storageKind
    if (args.storagePath) storage.path = args.storagePath
    overrides.storage = storage
  }

  return overrides
}

function renderJsonPanel(title: string, value: unknown, width: number): string {
  const raw = JSON.stringify(value, null, 2)
  const lines = raw.split("\n")
  const clipped = lines.length > 80 ? [...lines.slice(0, 80), `... ${lines.length - 80} more lines`] : lines
  return [
    `${title}`,
    "-".repeat(Math.min(width, Math.max(24, title.length))),
    ...clipped,
  ].join("\n")
}

function createProviderOverrides(args: TuiArgs): PartialDeep<AppConfig>["providers"] {
  const provider = args.provider ?? "openai-compatible"
  const patch = {
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
  }

  if (provider === "anthropic") {
    return { anthropic: patch }
  }

  if (provider === "gemini") {
    return { gemini: patch }
  }

  if (provider !== "openai-compatible") {
    return {
      custom: {
        [provider]: {
          protocol: provider === "openai-chat" ? "openai-chat" : "openai-compatible",
          baseUrl: args.baseUrl ?? "https://api.openai.com/v1/chat/completions",
          ...(args.apiKey ? { apiKey: args.apiKey } : {}),
          apiKeyEnv: args.apiKeyEnv ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        },
      },
    }
  }

  return { openaiCompatible: patch }
}

function readValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

function readPositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(readValue(value, name))
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function getProviderBaseUrl(config: AppConfig, provider: string): string {
  if (provider === "anthropic") return config.providers.anthropic.baseUrl
  if (provider === "gemini") return config.providers.gemini.baseUrl
  if (config.providers.custom[provider]) return config.providers.custom[provider].baseUrl
  if (isOpenAICompatibleProvider(provider)) return config.providers.openaiCompatible.baseUrl
  return ""
}

function getProviderApiKey(config: AppConfig, provider: string): string | undefined {
  if (provider === "anthropic") return config.providers.anthropic.apiKey
  if (provider === "gemini") return config.providers.gemini.apiKey
  if (config.providers.custom[provider]) return config.providers.custom[provider].apiKey
  if (isOpenAICompatibleProvider(provider)) return config.providers.openaiCompatible.apiKey
  return undefined
}

function builtinProtocol(provider: string): ProviderProtocol {
  if (provider === "anthropic") return "anthropic-messages"
  if (provider === "gemini") return "gemini-generative-language"
  if (provider === "openai-chat") return "openai-chat"
  return "openai-compatible"
}

function applyProviderConfig(config: AppConfig, provider: string, apiKey: string, baseUrl: string, protocol: ProviderProtocol): void {
  if (provider === "anthropic") {
    config.providers.anthropic.apiKey = apiKey
    config.providers.anthropic.baseUrl = baseUrl || config.providers.anthropic.baseUrl
  } else if (provider === "gemini") {
    config.providers.gemini.apiKey = apiKey
    config.providers.gemini.baseUrl = baseUrl || config.providers.gemini.baseUrl
  } else if (provider === "openai-compatible") {
    config.providers.openaiCompatible.apiKey = apiKey
    if (baseUrl) config.providers.openaiCompatible.baseUrl = baseUrl
  } else {
    // Custom provider — add or update entry in providers.custom
    if (config.providers.custom[provider]) {
      config.providers.custom[provider].apiKey = apiKey
      if (baseUrl) config.providers.custom[provider].baseUrl = baseUrl
    } else {
      config.providers.custom[provider] = {
        protocol,
        baseUrl: baseUrl || "",
        apiKey,
        apiKeyEnv: `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      }
    }
  }
}

function maybePromoteOpenAICompatibleConnection(config: AppConfig, provider: string, baseUrl: string): string {
  if (provider !== "openai-compatible" || !baseUrl || isDefaultOpenAIBaseUrl(baseUrl)) {
    return provider
  }

  const inferred = inferProviderNameFromBaseUrl(baseUrl)
  if (!inferred || inferred === provider) {
    return provider
  }

  if (!config.providers.custom[inferred] || sameBaseUrl(config.providers.custom[inferred].baseUrl, baseUrl)) {
    return inferred
  }

  for (let index = 2; index < 100; index += 1) {
    const candidate = `${inferred}-${index}`
    if (!config.providers.custom[candidate] || sameBaseUrl(config.providers.custom[candidate].baseUrl, baseUrl)) {
      return candidate
    }
  }

  return inferred
}

function inferProviderNameFromBaseUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "local-openai"
    }

    const withoutApi = host.replace(/^api\./, "")
    const label = withoutApi.split(".").find((part) => part.length > 0)
    const provider = label?.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    return provider || undefined
  } catch {
    return undefined
  }
}

function isDefaultOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"
  } catch {
    return false
  }
}

function sameBaseUrl(left: string, right: string): boolean {
  return trimTrailingSlash(left) === trimTrailingSlash(right)
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function isOpenAICompatibleProvider(provider: string): boolean {
  return provider === "openai" || provider === "openai-chat" || provider === "openai-compatible"
}

function usesSharedOpenAIConfig(config: AppConfig, provider: string): boolean {
  return provider === "openai-compatible" || (isOpenAICompatibleProvider(provider) && !config.providers.custom[provider])
}

function keyChangeAffectsActiveProvider(config: AppConfig, changedProvider: string, activeProvider: string): boolean {
  if (changedProvider === activeProvider) return true
  return usesSharedOpenAIConfig(config, changedProvider) && usesSharedOpenAIConfig(config, activeProvider)
}

function pickReplacementModel(config: AppConfig, removed: ModelRef): ModelRef {
  if (config.models.fallback && !isSameModel(config.models.fallback, removed)) {
    return config.models.fallback
  }

  const remaining = config.models.catalog.find((entry) => !isSameModel(entry, removed))
  if (remaining) {
    return { provider: remaining.provider, model: remaining.model }
  }

  return { provider: "mock", model: "mock-agent" }
}

function isSameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model
}

function filterModelCatalog(catalog: ModelCatalogEntry[], query: string): ModelCatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return catalog
  return catalog.filter((e) => `${e.provider}/${e.model}`.toLowerCase().includes(q))
}

function extractScreenText(
  buffer: string[],
  start: { x: number; y: number },
  end: { x: number; y: number },
): string {
  const [from, to] =
    start.y < end.y || (start.y === end.y && start.x <= end.x)
      ? [start, end]
      : [end, start]

  const r1 = from.y - 1
  const c1 = from.x - 1
  const r2 = to.y - 1
  const c2 = to.x

  if (buffer.length === 0) return ""

  if (r1 === r2) {
    return (buffer[r1] ?? "").slice(c1, c2)
  }

  const lines: string[] = [(buffer[r1] ?? "").slice(c1)]
  for (let r = r1 + 1; r < r2; r++) lines.push(buffer[r] ?? "")
  lines.push((buffer[r2] ?? "").slice(0, c2))
  return lines.join("\n")
}

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string
    let args: string[]
    if (process.platform === "win32") {
      cmd = "clip.exe"
      args = []
    } else if (process.platform === "darwin") {
      cmd = "pbcopy"
      args = []
    } else {
      cmd = "xclip"
      args = ["-selection", "clipboard"]
    }

    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    proc.stdin.write(text, "utf8")
    proc.stdin.end()
    proc.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`clipboard exited with code ${code}`))
      }
    })
    proc.on("error", (err) => {
      if (process.platform === "linux") {
        const fallback = spawn("xsel", ["--clipboard", "--input"], { stdio: ["pipe", "ignore", "ignore"] })
        fallback.stdin.write(text, "utf8")
        fallback.stdin.end()
        fallback.on("close", (code2) => code2 === 0 ? resolve() : reject(new Error("clipboard unavailable (install xclip or xsel)")))
        fallback.on("error", () => reject(new Error("clipboard unavailable (install xclip or xsel)")))
      } else {
        reject(err)
      }
    })
  })
}
