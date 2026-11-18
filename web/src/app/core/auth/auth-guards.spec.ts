import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { authGuard, guestGuard, safeReturnUrl } from './auth-guards';
import { AuthSession } from './auth-session';

@Component({ template: 'page', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

describe('auth guards', () => {
  let signedIn: boolean;

  beforeEach(() => {
    signedIn = false;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: BlankPage, canActivate: [guestGuard] },
          {
            path: '',
            canActivateChild: [authGuard],
            children: [
              { path: 'dashboard', component: BlankPage },
              { path: 'properties', component: BlankPage },
            ],
          },
        ]),
        { provide: AuthSession, useValue: { isAuthenticated: () => signedIn } },
      ],
    });
  });

  async function go(url: string): Promise<string> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router).url;
  }

  it('sends a signed-out user to the login page with the URL they wanted', async () => {
    expect(await go('/properties?status=draft')).toBe(
      '/login?returnUrl=%2Fproperties%3Fstatus%3Ddraft',
    );
  });

  it('lets a signed-in user through', async () => {
    signedIn = true;
    expect(await go('/properties')).toBe('/properties');
  });

  it('sends a signed-in user away from the login page', async () => {
    signedIn = true;
    expect(await go('/login')).toBe('/dashboard');
  });

  it('shows the login page when signed out', async () => {
    expect(await go('/login')).toBe('/login');
  });
});

describe('safeReturnUrl', () => {
  it.each([
    ['/properties?status=draft', '/properties?status=draft'],
    ['/jobs', '/jobs'],
    [null, '/dashboard'],
    ['', '/dashboard'],
    ['https://evil.example/', '/dashboard'],
    ['//evil.example/', '/dashboard'],
    ['/\\evil.example', '/dashboard'],
    ['/login?returnUrl=/jobs', '/dashboard'],
    ['properties', '/dashboard'],
  ])('%j → %s', (input, expected) => {
    expect(safeReturnUrl(input)).toBe(expected);
  });
});
