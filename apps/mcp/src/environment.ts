import { env } from 'node:process';

export function setting(name: string) {
  return env[`CAIRUL_${name}`] ?? env[`KAIR0_${name}`];
}
