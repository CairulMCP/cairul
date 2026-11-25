import { Configuration, HealthApi, JourneysApi, ResponseError } from '@cairul/sdk';
import { setting } from '../environment.js';

function connectBackend() {
  const basePath = (setting('API_URL') ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const configuration = new Configuration({ basePath });
  return { health: new HealthApi(configuration), journeys: new JourneysApi(configuration) };
}

export const backend = setting('BACKEND_ENABLED') === 'true' ? connectBackend() : undefined;

export function errorResponse(error: unknown): Response | undefined {
  if (error instanceof ResponseError) return error.response;
}
