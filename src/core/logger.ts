export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLogLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

const shouldLog = (level: LogLevel): boolean =>
  LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLogLevel];

export class SystemLogger {
  private serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  private sendLog(level: LogLevel, message: unknown, details?: any) {
    if (!shouldLog(level)) {
      return;
    }
    const text = typeof message === 'string' ? message : String(message);
    const timestamp = new Date().toISOString();
    const detailsStr = details ? ` ${JSON.stringify(details)}` : '';
    const logMessage = `[${timestamp}] [${this.serviceName}] [${level.toUpperCase()}] ${text}${detailsStr}`;

    const logMethod =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logMethod(logMessage);
  }

  info(message: unknown, details?: any) {
    this.sendLog('info', message, details);
  }

  warn(message: unknown, details?: any) {
    this.sendLog('warn', message, details);
  }

  error(message: unknown, details?: any) {
    this.sendLog('error', message, details);
  }

  debug(message: unknown, details?: any) {
    this.sendLog('debug', message, details);
  }
}
