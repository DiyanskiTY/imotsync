import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { catchError, map, of, startWith, Subject, switchMap } from 'rxjs';

import { SHOW_DEV_HINTS } from '../../core/dev-hints';
import {
  describeHealthError,
  HealthApi,
  HealthCheckFailure,
  HealthReport,
} from '../../core/health/health-api';
import { formatUptime } from '../../shared/format-uptime';
import { PageHeader } from '../../shared/page-header';

export type HealthState =
  | { kind: 'loading' }
  | { kind: 'ready'; report: HealthReport; checkedAt: Date }
  | { kind: 'error'; failure: HealthCheckFailure; checkedAt: Date };

type TagSeverity = 'success' | 'secondary' | 'info' | 'warn' | 'danger' | 'contrast';

export interface StatusTile {
  label: string;
  icon: string;
  value: string;
  /** When set, the value is shown as a tag with this severity. */
  severity?: TagSeverity;
  detail: string;
}

interface Step {
  title: string;
  icon: string;
  text: string;
}

@Component({
  selector: 'app-dashboard-page',
  imports: [
    DatePipe,
    ButtonModule,
    CardModule,
    MessageModule,
    SkeletonModule,
    TagModule,
    PageHeader,
  ],
  templateUrl: './dashboard-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage {
  private readonly healthApi = inject(HealthApi);
  private readonly refreshRequests = new Subject<void>();

  /** Development builds explain how to start the API and the database; production builds do not. */
  protected readonly showDevHints = inject(SHOW_DEV_HINTS);

  /** Health check state; every refresh cancels the previous request. */
  protected readonly state: Signal<HealthState> = toSignal(
    this.refreshRequests.pipe(
      startWith(undefined),
      switchMap(() =>
        this.healthApi.getHealth().pipe(
          map((report): HealthState => ({ kind: 'ready', report, checkedAt: new Date() })),
          catchError((error: unknown) =>
            of<HealthState>({
              kind: 'error',
              failure: describeHealthError(error),
              checkedAt: new Date(),
            }),
          ),
          startWith<HealthState>({ kind: 'loading' }),
        ),
      ),
    ),
    { requireSync: true },
  );

  protected readonly loading = computed(() => this.state().kind === 'loading');
  protected readonly tiles = computed(() => buildTiles(this.state()));

  protected readonly checkedAt = computed(() => {
    const state = this.state();
    return state.kind === 'loading' ? null : state.checkedAt;
  });

  protected readonly failure = computed(() => {
    const state = this.state();
    return state.kind === 'error' ? state.failure : null;
  });

  protected readonly databaseDown = computed(() => {
    const state = this.state();
    return state.kind === 'ready' && state.report.db === 'down';
  });

  protected readonly steps: readonly Step[] = [
    {
      title: 'Prepare',
      icon: 'pi pi-pencil',
      text: 'Enter the property once, with photos and a description. It starts as a draft.',
    },
    {
      title: 'Check',
      icon: 'pi pi-list-check',
      text: "Each selected portal's required fields and photo rules are checked before publishing.",
    },
    {
      title: 'Publish',
      icon: 'pi pi-send',
      text: "A background job per portal delivers the listing through the portal's official import feed.",
    },
    {
      title: 'Track',
      icon: 'pi pi-eye',
      text: 'Follow every portal: draft, pending, published, error or removed, with retries.',
    },
  ];

  protected refresh(): void {
    this.refreshRequests.next();
  }
}

const API_TILE = { label: 'API', icon: 'pi pi-server' };
const DATABASE_TILE = { label: 'Database', icon: 'pi pi-database' };
const VERSION_TILE = { label: 'Version', icon: 'pi pi-tag' };
const UPTIME_TILE = { label: 'Uptime', icon: 'pi pi-clock' };

/** Maps the health state to the four status tiles shown on the dashboard. */
export function buildTiles(state: HealthState): StatusTile[] {
  if (state.kind === 'loading') {
    return [API_TILE, DATABASE_TILE, VERSION_TILE, UPTIME_TILE].map((tile) => ({
      ...tile,
      value: '',
      detail: '',
    }));
  }

  if (state.kind === 'error') {
    const api: StatusTile = state.failure.unreachable
      ? { ...API_TILE, value: 'Offline', severity: 'danger', detail: 'No response from the API' }
      : { ...API_TILE, value: 'Error', severity: 'danger', detail: 'Health check failed' };
    return [
      api,
      { ...DATABASE_TILE, value: 'Unknown', severity: 'secondary', detail: 'Reported by the API' },
      { ...VERSION_TILE, value: '—', detail: 'Not available' },
      { ...UPTIME_TILE, value: '—', detail: 'Not available' },
    ];
  }

  const { report } = state;
  const apiOk = report.status === 'ok';
  const dbUp = report.db === 'up';
  return [
    {
      ...API_TILE,
      value: apiOk ? 'Online' : 'Degraded',
      severity: apiOk ? 'success' : 'warn',
      detail: apiOk ? 'Responding normally' : 'Running with a failing dependency',
    },
    {
      ...DATABASE_TILE,
      value: dbUp ? 'Up' : 'Down',
      severity: dbUp ? 'success' : 'danger',
      detail: dbUp ? 'Connection check passed' : 'Connection check failed',
    },
    { ...VERSION_TILE, value: `v${report.version}`, detail: 'API release' },
    { ...UPTIME_TILE, value: formatUptime(report.uptimeSeconds), detail: 'Since the last restart' },
  ];
}
