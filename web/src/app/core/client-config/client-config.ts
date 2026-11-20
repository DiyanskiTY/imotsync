import { HttpClient } from '@angular/common/http';
import {
  computed,
  inject,
  Injectable,
  makeEnvironmentProviders,
  provideAppInitializer,
  signal,
} from '@angular/core';
import { catchError, firstValueFrom, of, timeout } from 'rxjs';

import type { ClientConfig, UploadLimits } from '../api/models';

export const CLIENT_CONFIG_URL = '/api/client-config';

/** How long start-up waits for the configuration before going on with the defaults. */
export const CLIENT_CONFIG_TIMEOUT_MS = 5_000;

/** The API's default photo limits (README › Photos), used until the API has said otherwise. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 15 * 1024 * 1024,
  maxFilesPerRequest: 20,
  maxPerProperty: 40,
};

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  demoMode: false,
  uploadLimits: DEFAULT_UPLOAD_LIMITS,
};

/**
 * What this deployment of the API asks of the admin panel (GET /api/client-config): whether it
 * is the public demo, and its photo limits. Loaded once, before the first page is shown. When the
 * API cannot be reached the defaults stay; the API applies its own limits either way.
 */
@Injectable({ providedIn: 'root' })
export class ClientConfigStore {
  private readonly http = inject(HttpClient);
  private readonly config = signal<ClientConfig>(DEFAULT_CLIENT_CONFIG);

  readonly demoMode = computed(() => this.config().demoMode);
  readonly uploadLimits = computed(() => this.config().uploadLimits);

  async load(): Promise<void> {
    const loaded = await firstValueFrom(
      this.http.get<unknown>(CLIENT_CONFIG_URL).pipe(
        timeout(CLIENT_CONFIG_TIMEOUT_MS),
        catchError(() => of(null)),
      ),
    );
    if (isClientConfig(loaded)) {
      this.config.set(loaded);
    }
  }
}

/** Loads the client configuration before the app starts. */
export function provideClientConfig() {
  return makeEnvironmentProviders([provideAppInitializer(() => inject(ClientConfigStore).load())]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isClientConfig(value: unknown): value is ClientConfig {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { demoMode, uploadLimits } = value as Record<string, unknown>;
  if (typeof demoMode !== 'boolean' || typeof uploadLimits !== 'object' || uploadLimits === null) {
    return false;
  }
  const limits = uploadLimits as Record<string, unknown>;
  return (
    isPositiveInteger(limits['maxFileBytes']) &&
    isPositiveInteger(limits['maxFilesPerRequest']) &&
    isPositiveInteger(limits['maxPerProperty'])
  );
}
