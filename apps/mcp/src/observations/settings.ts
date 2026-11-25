import { setting } from '../environment.js';

export const observationsEnabled = () => setting('TELEMETRY') !== 'false';
