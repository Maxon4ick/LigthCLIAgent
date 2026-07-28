import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

let temporarySequence = 0

export function resolveWorkspacePath(cwd: string, configuredPath: string, label: string): string {
  const root = path.resolve(cwd)
  const target = path.resolve(root, configuredPath)
  const relative = path.relative(root, target)
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return target
  }
  throw new Error(`${label} must stay inside the workspace: ${configuredPath}`)
}

export function readJsonFile<T>(filePath: string, empty: () => T, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(readFileSync(filePath, "utf8")) as unknown)
  } catch (error) {
    if (isFsError(error, "ENOENT")) return empty()
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}; the file was left unchanged.`, { cause: error })
    }
    throw error
  }
}

export function updateJsonFile<T, R>(
  filePath: string,
  empty: () => T,
  parse: (value: unknown) => T,
  mutate: (value: T) => R,
): R {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  let result!: R
  withFileLock(`${filePath}.lock`, () => {
    const latest = readJsonFile(filePath, empty, parse)
    result = mutate(latest)
    atomicWriteJson(filePath, latest)
  })
  return result
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${++temporarySequence}.tmp`
  let handle: number | undefined
  try {
    handle = openSync(temporary, "wx", 0o600)
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    closeSync(handle)
    handle = undefined
    renameSync(temporary, filePath)
  } finally {
    if (handle !== undefined) closeSync(handle)
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
    }
  }
}

function withFileLock(lockPath: string, operation: () => void): void {
  const deadline = Date.now() + 5_000
  let handle: number | undefined
  while (handle === undefined) {
    try {
      handle = openSync(lockPath, "wx", 0o600)
      writeFileSync(handle, `${process.pid}\n`, "utf8")
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error
      removeStaleLock(lockPath)
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for storage lock: ${lockPath}`)
      }
      sleepSync(25)
    }
  }

  try {
    operation()
  } finally {
    closeSync(handle)
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error
    }
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath)
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === code
}
