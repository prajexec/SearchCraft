import { inspect } from 'node:util';

import type { LogLevel } from '../config';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  readonly [key: string]: unknown;
}

export class Logger {
  public constructor(private readonly level: LogLevel) {}

  public debug(message: string, context: LogContext = {}): void {
    this.write('debug', message, context);
  }

  public info(message: string, context: LogContext = {}): void {
    this.write('info', message, context);
  }

  public warn(message: string, context: LogContext = {}): void {
    this.write('warn', message, context);
  }

  public error(message: string, context: LogContext = {}): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const normalizedContext = Object.fromEntries(
      Object.entries(context).map(([key, value]) => [
        key,
        value instanceof Error ? inspect(value) : value,
      ]),
    );
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...normalizedContext,
    });

    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
      return;
    }

    process.stdout.write(`${line}\n`);
  }
}
