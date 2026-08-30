/**
 * Where the library reports what it is doing. The global `console` satisfies
 * this as it is, and so does any structured logger wrapped to match.
 *
 * Messages are constants and every value travels in `attributes`, so a backend
 * can group lines by message whatever it does with the rest. Nothing above
 * `info` is written while a group is healthy: `warn` means the worker lost a
 * lease it had, and `error` means something outside the library broke.
 */
export interface Console {
  trace(message: string, attributes: Record<string, unknown>): void
  debug(message: string, attributes: Record<string, unknown>): void
  info(message: string, attributes: Record<string, unknown>): void
  warn(message: string, attributes: Record<string, unknown>): void
  error(message: string, attributes: Record<string, unknown>): void
}

const nothing = () => {}

const SILENT: Console = {
  trace: nothing,
  debug: nothing,
  info: nothing,
  warn: nothing,
  error: nothing,
}

/**
 * A console bound to the attributes every line of a group carries, and kept
 * from throwing.
 *
 * Reporting on the loop must not be able to break it: a console that threw
 * would be counted as a failed registration on one path, and would take the
 * process down from a timer on another.
 */
export const sink = (console: Console | undefined, base: Record<string, unknown>): Console => {
  if (!console) return SILENT

  const guard =
    (level: keyof Console) => (message: string, attributes: Record<string, unknown>) => {
      try {
        console[level](message, { ...base, ...attributes })
      } catch {
        // A console of the caller's does not get to end the loop.
      }
    }

  return {
    trace: guard('trace'),
    debug: guard('debug'),
    info: guard('info'),
    warn: guard('warn'),
    error: guard('error'),
  }
}
