export class AppError extends Error {
  constructor(
    message: string,
    readonly code = "APP_ERROR",
    readonly statusCode = 500,
  ) {
    super(message)
    this.name = "AppError"
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, "NOT_FOUND", 404)
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, "BAD_REQUEST", 400)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, "UNAUTHORIZED", 401)
  }
}

export function errorToJson(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error) {
    return { code: "ERROR", message: error.message }
  }

  return { code: "ERROR", message: String(error) }
}
