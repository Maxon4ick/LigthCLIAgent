import { redactMessageParts, redactSecrets } from "../security/redaction.js"
import type { ProviderRequest } from "./provider.js"

export function sanitizeProviderRequest(input: ProviderRequest): ProviderRequest {
  return {
    ...input,
    systemContext: {
      ...input.systemContext,
      text: redactSecrets(input.systemContext.text),
    },
    messages: input.messages.map((message) => ({
      ...message,
      parts: redactMessageParts(message.parts),
    })),
  }
}
