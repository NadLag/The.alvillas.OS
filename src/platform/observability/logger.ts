export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  jobId?: string;
};

export type LogRecord = LogContext & {
  level: LogLevel;
  message: string;
  time: string;
  data?: unknown;
};

export type LoggerSink = {
  debug?(line: string): void;
  info?(line: string): void;
  warn?(line: string): void;
  error?(line: string): void;
  log(line: string): void;
};

const sensitiveKeyPattern = /(authorization|cookie|email|password|phone|secret|token|key)$/iu;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[redacted]" : redact(nested)
    ])
  );
}

export class StructuredLogger {
  constructor(
    private readonly sink: LoggerSink = console,
    private readonly now: () => Date = () => new Date()
  ) {}

  child(context: LogContext): StructuredLoggerWithContext {
    return new StructuredLoggerWithContext(this, context);
  }

  write(level: LogLevel, message: string, context: LogContext = {}, data?: unknown): void {
    const record: LogRecord = {
      level,
      message,
      time: this.now().toISOString(),
      ...context,
      ...(data === undefined ? {} : { data: redact(data) })
    };
    const line = JSON.stringify(record);

    if (level === "debug" && this.sink.debug) {
      this.sink.debug(line);
      return;
    }

    if (level === "info" && this.sink.info) {
      this.sink.info(line);
      return;
    }

    if (level === "warn" && this.sink.warn) {
      this.sink.warn(line);
      return;
    }

    if (level === "error" && this.sink.error) {
      this.sink.error(line);
      return;
    }

    this.sink.log(line);
  }

  debug(message: string, context?: LogContext, data?: unknown): void {
    this.write("debug", message, context, data);
  }

  info(message: string, context?: LogContext, data?: unknown): void {
    this.write("info", message, context, data);
  }

  warn(message: string, context?: LogContext, data?: unknown): void {
    this.write("warn", message, context, data);
  }

  error(message: string, context?: LogContext, data?: unknown): void {
    this.write("error", message, context, data);
  }
}

export class StructuredLoggerWithContext {
  constructor(
    private readonly logger: StructuredLogger,
    private readonly context: LogContext
  ) {}

  info(message: string, data?: unknown): void {
    this.logger.info(message, this.context, data);
  }

  warn(message: string, data?: unknown): void {
    this.logger.warn(message, this.context, data);
  }

  error(message: string, data?: unknown): void {
    this.logger.error(message, this.context, data);
  }
}

export const logger = new StructuredLogger();
