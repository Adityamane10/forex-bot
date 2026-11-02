import { config } from '../config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface LogEntry {
  level: Level;
  msg: string;
  meta?: Record<string, unknown>;
  time: string;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[config.logLevel as Level] && config.logLevel !== 'debug') return;
  const entry: LogEntry = { level, msg, meta, time: new Date().toISOString() };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
