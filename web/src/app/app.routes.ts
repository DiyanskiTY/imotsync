import { Routes } from '@angular/router';

import { Shell } from './layout/shell';

export const routes: Routes = [
  {
    path: '',
    component: Shell,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard-page').then((m) => m.DashboardPage),
      },
      {
        path: 'properties',
        title: 'Properties',
        loadComponent: () =>
          import('./features/properties/properties-page').then((m) => m.PropertiesPage),
      },
      {
        path: 'jobs',
        title: 'Jobs',
        loadComponent: () => import('./features/jobs/jobs-page').then((m) => m.JobsPage),
      },
      {
        path: '**',
        title: 'Page not found',
        loadComponent: () =>
          import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },
];
