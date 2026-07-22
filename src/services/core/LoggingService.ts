import { injectable } from '@/fw/di';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly id: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly data?: unknown;
  /** Origin label for non-editor entries (e.g. a remote preview device). */
  readonly source?: string;
}

export type LogListener = (entry: LogEntry) => void;

@injectable()
export class LoggingService {
  private readonly logs: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();
  private readonly maxLogs = 1000; // Keep only the last 1000 logs
  private logIdCounter = 0;
  private readonly enabledLevels = new Set<LogLevel>(['info', 'warn', 'error']);

  /**
   * Log a debug message
   */
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  /**
   * Log an entry attributed to an external source (e.g. a remote preview device).
   */
  logFrom(source: string, level: LogLevel, message: string, data?: unknown): void {
    this.log(level, message, data, source);
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, data?: unknown, source?: string): void {
    if (!this.enabledLevels.has(level)) {
      return;
    }

    const entry: LogEntry = {
      id: `log-${this.logIdCounter++}`,
      level,
      message,
      timestamp: Date.now(),
      data,
      ...(source ? { source } : {}),
    };

    this.logs.push(entry);

    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }

    // Notify all listeners
    this.listeners.forEach(listener => listener(entry));

    // Also log to console in development
    if (import.meta.env.DEV) {
      const prefix = `[Pix3 ${level.toUpperCase()}] ${message}`;
      if (level === 'debug') {
        console.debug(prefix, data);
      } else if (level === 'info') {
        console.log(prefix, data);
      } else if (level === 'warn') {
        console.warn(prefix, data);
      } else if (level === 'error') {
        console.error(prefix, data);
      }
    }
  }

  /**
   * Get all logs
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(...levels: LogLevel[]): LogEntry[] {
    const levelSet = new Set(levels);
    return this.logs.filter(log => levelSet.has(log.level));
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.logs.length = 0;
    this.logIdCounter = 0;
  }

  /**
   * Subscribe to log entries
   */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Set enabled log levels
   */
  setEnabledLevels(levels: LogLevel[]): void {
    this.enabledLevels.clear();
    levels.forEach(level => this.enabledLevels.add(level));
  }

  /**
   * Get enabled log levels
   */
  getEnabledLevels(): LogLevel[] {
    return Array.from(this.enabledLevels);
  }

  /**
   * Toggle a log level on/off
   */
  toggleLevel(level: LogLevel): void {
    if (this.enabledLevels.has(level)) {
      this.enabledLevels.delete(level);
    } else {
      this.enabledLevels.add(level);
    }
  }

  /**
   * Check if a log level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return this.enabledLevels.has(level);
  }

  dispose(): void {
    this.listeners.clear();
    this.logs.length = 0;
  }
}
