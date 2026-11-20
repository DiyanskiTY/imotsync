import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { MessageModule } from 'primeng/message';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { finalize, startWith, Subject } from 'rxjs';

import { ClientConfigStore } from '../../core/client-config/client-config';
import { SHOW_DEV_HINTS } from '../../core/dev-hints';
import { HealthApi, HealthReport } from '../../core/health/health-api';
import { formatUptime } from '../../shared/format-uptime';
import { PageHeader } from '../../shared/page-header';
import { RemoteState, remoteState } from '../../shared/remote-state';
import { PortalFeeds } from './portal-feeds';

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
    PortalFeeds,
  ],
  templateUrl: './dashboard-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage {
  private readonly healthApi = inject(HealthApi);
  private readonly refreshRequests = new Subject<void>();

  /** Development builds explain how to start the API and the database; production builds do not. */
  protected readonly showDevHints = inject(SHOW_DEV_HINTS);
  protected readonly demoMode = inject(ClientConfigStore).demoMode;

  /** When the last check finished, successfully or not; null until the first one has. */
  protected readonly checkedAt = signal<Date | null>(null);

  /** The health check; every refresh cancels the previous request. */
  private readonly health = toSignal(
    remoteState(this.refreshRequests.pipe(startWith(undefined)), () =>
      this.healthApi.getHealth().pipe(finalize(() => this.checkedAt.set(new Date()))),
    ),
    { requireSync: true },
  );

  /** A check is running (the Refresh button spins). */
  protected readonly checking = computed(() => this.health().loading);
  /** Nothing to show yet: the tiles are placeholders. */
  protected readonly waiting = computed(() => {
    const { data, error } = this.health();
    return data === null && error === null;
  });
  protected readonly tiles = computed(() => buildTiles(this.health()));
  protected readonly failure = computed(() => this.health().error);
  protected readonly databaseDown = computed(() => {
    const { data, error } = this.health();
    return error === null && data?.db === 'down';
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

/**
 * Maps the health check to the four status tiles shown on the dashboard. A failed check wins over
 * an earlier report; while a check runs, the last report stays on screen.
 */
export function buildTiles({ data: report, error }: RemoteState<HealthReport>): StatusTile[] {
  if (error !== null) {
    const api: StatusTile = error.unreachable
      ? { ...API_TILE, value: 'Offline', severity: 'danger', detail: 'No response from the API' }
      : { ...API_TILE, value: 'Error', severity: 'danger', detail: 'Health check failed' };
    return [
      api,
      { ...DATABASE_TILE, value: 'Unknown', severity: 'secondary', detail: 'Reported by the API' },
      { ...VERSION_TILE, value: '—', detail: 'Not available' },
      { ...UPTIME_TILE, value: '—', detail: 'Not available' },
    ];
  }

  if (report === null) {
    return [API_TILE, DATABASE_TILE, VERSION_TILE, UPTIME_TILE].map((tile) => ({
      ...tile,
      value: '',
      detail: '',
    }));
  }

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
