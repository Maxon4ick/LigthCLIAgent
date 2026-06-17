export interface ProviderFetchPolicyOptions {
  maxRetries?: number
  headerTimeoutMs?: number
  baseDelayMs?: number
}

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_HEADER_TIMEOUT_MS = 30_000
const DEFAULT_BASE_DELAY_MS = 150

export async function fetchWithProviderPolicy(
  input: string | URL | Request,
  init: RequestInit,
  options: ProviderFetchPolicyOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Provider request timed out waiting for response headers after ${headerTimeoutMs}ms`))
    }, headerTimeoutMs)

    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timeout)
        throw abortError(init.signal.reason)
      }
      init.signal.addEventListener("abort", () => controller.abort(init.signal?.reason), { once: true })
    }

    try {
      const response = await fetch(input, { ...init, signal: controller.signal })
      clearTimeout(timeout)

      if (!shouldRetryStatus(response.status) || attempt === maxRetries) {
        return response
      }

      await response.body?.cancel().catch(() => undefined)
      await delay(backoffDelay(baseDelayMs, attempt), init.signal)
    } catch (error) {
      clearTimeout(timeout)
      if (init.signal?.aborted) {
        throw error
      }
      if (attempt === maxRetries) {
        throw error
      }
      await delay(backoffDelay(baseDelayMs, attempt), init.signal)
    }
  }

  throw new Error("Provider request retry loop exhausted unexpectedly")
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function backoffDelay(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** attempt
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason))
      return
    }

    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(abortError(signal.reason))
      },
      { once: true },
    )
  })
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason
  }

  return new Error(typeof reason === "string" ? reason : "Operation aborted")
}
