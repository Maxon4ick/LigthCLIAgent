export async function tuiCommand(args: string[]): Promise<void> {
  const { tuiCommand: runTui } = await import("../../adapters/tui/index.js")
  await runTui(args)
}
