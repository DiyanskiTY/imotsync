import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth/auth-guards';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    // Lazy as well: the layout carries the toast and dialog code, which the login page does not need.
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    canActivate: [authGuard],
    canActivateChild: [authGuard],
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
          import('./features/properties/property-list-page').then((m) => m.PropertyListPage),
      },
      {
        path: 'properties/new',
        title: 'New property',
        loadComponent: () =>
          import('./features/properties/property-edit-page').then((m) => m.PropertyEditPage),
      },
      {
        path: 'properties/:id',
        title: 'Property',
        loadComponent: () =>
          import('./features/properties/property-edit-page').then((m) => m.PropertyEditPage),
      },
      {
        path: 'jobs',
        title: 'Jobs',
        loadComponent: () => import('./features/jobs/job-log-page').then((m) => m.JobLogPage),
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
