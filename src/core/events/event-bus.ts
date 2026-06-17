import type { AppEvent, AppEventDraft } from "./event-types.js"

export type EventListener = (event: AppEvent) => void

export interface SubscribeOptions {
  sessionId?: string
}

export class EventBus {
  private listeners = new Set<{ listener: EventListener; options: SubscribeOptions }>()
  private events: AppEvent[] = []
  private nextId = 1

  constructor(private readonly maxEvents = 1_000) {}

  publish(draft: AppEventDraft): AppEvent {
    const sequence = this.nextId++
    const event: AppEvent = {
      ...draft,
      id: sequence,
      sequence,
      version: 1,
      createdAt: new Date().toISOString(),
    } as AppEvent

    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents)
    }

    for (const item of this.listeners) {
      if (matchesOptions(event, item.options)) {
        item.listener(event)
      }
    }

    return event
  }

  subscribe(listener: EventListener, options: SubscribeOptions = {}): () => void {
    const item = { listener, options }
    this.listeners.add(item)
    return () => {
      this.listeners.delete(item)
    }
  }

  history(options: SubscribeOptions = {}): AppEvent[] {
    return this.events.filter((event) => matchesOptions(event, options))
  }
}

function matchesOptions(event: AppEvent, options: SubscribeOptions): boolean {
  if (!options.sessionId) {
    return true
  }

  const payload = event.payload as { sessionId?: string; session?: { id: string } }
  return payload.sessionId === options.sessionId || payload.session?.id === options.sessionId
}
