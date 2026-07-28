export interface SecretFinding {
  path: string
  line: number
  rule: string
}

export function scanText(text: string, filePath?: string, production?: boolean): SecretFinding[]
export function scanPaths(paths: string[], repositoryRoot?: string): SecretFinding[]
export function collectScanPaths(repositoryRoot?: string): string[]
