import { createId } from "../../../shared/ids.js"
import type { TodoItem } from "../../session/message-types.js"
import type { ToolDefinition } from "../tool.js"

interface TodoWriteInput {
  todos: Array<{
    id?: string
    content: string
    status: TodoItem["status"]
  }>
}

interface TodoWriteOutput {
  todos: TodoItem[]
}

export const todoWriteTool: ToolDefinition<unknown, TodoWriteOutput> = {
  name: "todo_write",
  description: "Persist the session todo list for multi-step coding tasks.",
  kind: "other",
  metadata: {
    safeConcurrent: false,
    mutatesWorkspace: false,
    requiresApproval: false,
    tags: ["agent", "todo"],
  },
  inputSchema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          required: ["content", "status"],
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
        },
      },
    },
  },
  async execute(input, context) {
    const todos = parseInput(input).todos.map((todo) => ({
      id: todo.id ?? createId("todo"),
      content: todo.content,
      status: todo.status,
    }))
    context.sessionStore.updateSession(context.sessionId, { todos })

    return {
      ok: true,
      output: { todos },
    }
  },
}

function parseInput(input: unknown): TodoWriteInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("todo_write input must be an object")
  }

  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) {
    throw new Error("todo_write.todos must be an array")
  }

  return {
    todos: todos.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`todo_write.todos[${index}] must be an object`)
      }
      const record = item as Record<string, unknown>
      if (record.id !== undefined && (typeof record.id !== "string" || record.id.length === 0)) {
        throw new Error(`todo_write.todos[${index}].id must be a non-empty string`)
      }
      if (typeof record.content !== "string" || record.content.length === 0) {
        throw new Error(`todo_write.todos[${index}].content must be a non-empty string`)
      }
      if (record.status !== "pending" && record.status !== "in_progress" && record.status !== "completed") {
        throw new Error(`todo_write.todos[${index}].status must be pending, in_progress, or completed`)
      }

      return {
        id: record.id,
        content: record.content,
        status: record.status,
      }
    }),
  }
}
