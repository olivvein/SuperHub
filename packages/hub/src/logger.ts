export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

export interface LogContext {
  [key: string]: unknown;
}

export class HubLogger {
  constructor(private readonly level: LogLevel) {}

  fatal(msg: string, context: LogContext = {}): void {
    this.log("fatal", msg, context);
  }

  error(msg: string, context: LogContext = {}): void {
    this.log("error", msg, context);
  }

  warn(msg: string, context: LogContext = {}): void {
    this.log("warn", msg, context);
  }

  info(msg: string, context: LogContext = {}): void {
    this.log("info", msg, context);
  }

  debug(msg: string, context: LogContext = {}): void {
    this.log("debug", msg, context);
  }

  trace(msg: string, context: LogContext = {}): void {
    this.log("trace", msg, context);
  }

  private log(level: LogLevel, msg: string, context: LogContext): void {
    if (!shouldLog(this.level, level)) {
      return;
    }

    const entry = {
      ts: Date.now(),
      level,
      msg,
      ...context
    };

    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

function shouldLog(configuredLevel: LogLevel, incomingLevel: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(incomingLevel) <= LEVEL_ORDER.indexOf(configuredLevel);
}
