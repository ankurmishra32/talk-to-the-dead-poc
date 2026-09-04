// Minimal structured logger for the PoC.
//
// Current implementation delegates to the platform console. Keeping the
// call sites behind this thin seam means failures are formatted
// consistently (with a namespace prefix useful for grepping in log files)
// and can later be swapped for a real backend like Sentry without editing
// every call site.
//
// Safe to import in both client components and server routes (no Node or
// browser globals beyond `console`).

type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, namespace: string, message: string, meta?: unknown) {
  const tag = `[${level.toUpperCase()}]`;
  const ns = namespace ? `[${namespace}]` : "";
  const args: unknown[] = [`${tag}${ns} ${message}`];
  if (meta !== undefined) args.push(meta);
  switch (level) {
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}

/**
 * Creates a logger scoped to a namespace (e.g. a component or route name)
 * so log/error lines are easy to filter.
 */
export function createLogger(namespace: string) {
  return {
    info: (message: string, meta?: unknown) => write("info", namespace, message, meta),
    warn: (message: string, meta?: unknown) => write("warn", namespace, message, meta),
    error: (message: string, err?: unknown, meta?: unknown) => {
      const merged = meta === undefined ? err : { err, ...(meta as object) };
      write("error", namespace, message, merged);
    },
  };
}
