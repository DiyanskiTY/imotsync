import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, of, Subject, throwError } from 'rxjs';

import type { User } from '../../core/api/models';
import { AuthSession } from '../../core/auth/auth-session';
import { ClientConfigStore } from '../../core/client-config/client-config';
import { LoginPage } from './login-page';

@Component({ template: 'target', changeDetection: ChangeDetectionStrategy.OnPush })
class BlankPage {}

const broker: User = {
  id: 2,
  email: 'broker@example.test',
  fullName: 'Demo Broker',
  role: 'broker',
};

describe('LoginPage', () => {
  let login: ReturnType<typeof vi.fn<(email: string, password: string) => Observable<User>>>;
  let loginToDemo: ReturnType<typeof vi.fn<() => Observable<User>>>;
  const demoMode = signal(false);

  beforeEach(() => {
    login = vi.fn(() => of(broker));
    loginToDemo = vi.fn(() => of(broker));
    demoMode.set(false);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: LoginPage },
          { path: 'dashboard', component: BlankPage },
          { path: 'properties', component: BlankPage },
        ]),
        { provide: AuthSession, useValue: { login, loginToDemo } },
        { provide: ClientConfigStore, useValue: { demoMode } },
      ],
    });
  });

  async function open(url = '/login') {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const root = harness.fixture.nativeElement as HTMLElement;
    return { harness, root };
  }

  function fill(root: HTMLElement, email: string, password: string): void {
    const emailInput = root.querySelector<HTMLInputElement>('[data-testid="login-email"]');
    const passwordInput = root.querySelector<HTMLInputElement>('#login-password');
    if (!emailInput || !passwordInput) {
      throw new Error('login inputs not found');
    }
    emailInput.value = email;
    emailInput.dispatchEvent(new Event('input'));
    passwordInput.value = password;
    passwordInput.dispatchEvent(new Event('input'));
  }

  async function submit(harness: RouterTestingHarness, root: HTMLElement): Promise<void> {
    root.querySelector('form')?.dispatchEvent(new Event('submit'));
    await harness.fixture.whenStable();
  }

  function errorText(root: HTMLElement): string {
    return root.querySelector('[data-testid="login-error"]')?.textContent?.trim() ?? '';
  }

  it('signs in and goes to the dashboard', async () => {
    const { harness, root } = await open();
    fill(root, 'broker@example.test', 'secret');
    await submit(harness, root);

    expect(login).toHaveBeenCalledWith('broker@example.test', 'secret');
    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  it('returns to the page the user wanted', async () => {
    const { harness, root } = await open('/login?returnUrl=%2Fproperties%3Fstatus%3Ddraft');
    fill(root, 'broker@example.test', 'secret');
    await submit(harness, root);

    expect(TestBed.inject(Router).url).toBe('/properties?status=draft');
  });

  it('never follows a return URL to another site', async () => {
    const { harness, root } = await open('/login?returnUrl=https%3A%2F%2Fevil.example');
    fill(root, 'broker@example.test', 'secret');
    await submit(harness, root);

    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  it('does not call the API while the form is incomplete', async () => {
    const { harness, root } = await open();
    fill(root, 'not-an-email', '');
    await submit(harness, root);

    expect(login).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Enter a valid email address.');
    expect(root.textContent).toContain('Enter your password.');
  });

  it('shows the API message for wrong credentials and stays on the page', async () => {
    login.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 401,
            error: {
              error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
            },
          }),
      ),
    );
    const { harness, root } = await open();
    fill(root, 'broker@example.test', 'wrong');
    await submit(harness, root);

    expect(errorText(root)).toBe('Invalid email or password.');
    expect(TestBed.inject(Router).url).toBe('/login');
  });

  it('says when to try again after too many attempts', async () => {
    login.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 429,
            headers: new HttpHeaders({ 'Retry-After': '600' }),
            error: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many login attempts.' } },
          }),
      ),
    );
    const { harness, root } = await open();
    fill(root, 'broker@example.test', 'x');
    await submit(harness, root);

    expect(errorText(root)).toBe('Too many login attempts. Try again in 10 minutes.');
  });

  it('disables the button while signing in', async () => {
    const pending = new Subject<User>();
    login.mockReturnValue(pending);
    const { harness, root } = await open();
    fill(root, 'broker@example.test', 'secret');
    await submit(harness, root);

    const button = root.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);
    pending.next(broker);
    pending.complete();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/dashboard');
  });

  describe('on the public demo', () => {
    const tryDemoButton = (root: HTMLElement) =>
      root.querySelector<HTMLButtonElement>('[data-testid="try-demo"] button');

    it('has no demo button anywhere else', async () => {
      const { root } = await open();
      expect(root.querySelector('[data-testid="demo-entry"]')).toBeNull();
    });

    it('signs in the demo account with one click and goes where the user wanted', async () => {
      demoMode.set(true);
      const { harness, root } = await open('/login?returnUrl=%2Fproperties');
      tryDemoButton(root)?.click();
      await harness.fixture.whenStable();

      expect(loginToDemo).toHaveBeenCalledOnce();
      expect(login).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe('/properties');
    });

    it('shows why the demo sign-in failed', async () => {
      demoMode.set(true);
      loginToDemo.mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 429,
              headers: new HttpHeaders({ 'Retry-After': '60' }),
              error: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many demo sign-ins.' } },
            }),
        ),
      );
      const { harness, root } = await open();
      tryDemoButton(root)?.click();
      await harness.fixture.whenStable();

      expect(errorText(root)).toBe('Too many demo sign-ins. Try again in 1 minute.');
      expect(TestBed.inject(Router).url).toBe('/login');
    });

    it('keeps the password form for real accounts', async () => {
      demoMode.set(true);
      const { harness, root } = await open();
      fill(root, 'broker@example.test', 'secret');
      await submit(harness, root);

      expect(login).toHaveBeenCalledWith('broker@example.test', 'secret');
    });
  });

  it('explains why a user was sent back to the login page', async () => {
    const { root } = await open('/login?reason=expired');
    expect(root.querySelector('[data-testid="login-notice"]')?.textContent).toContain(
      'Your session has ended',
    );
  });
});
