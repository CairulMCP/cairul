import { stderr } from 'node:process';
import { setting } from './environment.js';

const levels = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof levels)[number];

const configuredLevel = setting('LOG_LEVEL')?.trim().toLowerCase() || 'info';
const minimumLevel = levels.find((level) => level === configuredLevel) ?? 'info';

export function log(level: Level, message: string, attributes: Record<string, string | number> = {}) {
  if (levels.indexOf(level) >= levels.indexOf(minimumLevel)) {
    stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: level.toUpperCase(),
        msg: message,
        component: 'mcp',
        ...attributes,
      }) + '\n'
    );
  }
}

if (minimumLevel !== configuredLevel) {
  log('warn', 'using info for an invalid CAIRUL_LOG_LEVEL');
}
