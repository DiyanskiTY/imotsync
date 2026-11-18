import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { PasswordModule } from 'primeng/password';
import { finalize, map } from 'rxjs';

import { toApiError } from '../../core/api/api-error';
import { safeReturnUrl } from '../../core/auth/auth-guards';
import { AuthSession } from '../../core/auth/auth-session';

/** Sign-in form, outside the app shell. */
@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, ButtonModule, InputTextModule, MessageModule, PasswordModule],
  templateUrl: './login-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly session = inject(AuthSession);
  private readonly router = inject(Router);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sessionEnded = computed(() => this.query().get('reason') === 'expired');
  private readonly returnUrl = computed(() => safeReturnUrl(this.query().get('returnUrl')));

  protected showError(control: 'email' | 'password'): boolean {
    return this.submitted() && this.form.controls[control].invalid;
  }

  protected submit(): void {
    this.submitted.set(true);
    if (this.form.invalid || this.submitting()) {
      return;
    }
    const { email, password } = this.form.getRawValue();
    this.submitting.set(true);
    this.error.set(null);
    this.session
      .login(email, password)
      .pipe(
        map(() => this.returnUrl()),
        finalize(() => this.submitting.set(false)),
      )
      .subscribe({
        next: (url) => void this.router.navigateByUrl(url),
        error: (error: unknown) => this.error.set(describeLoginError(error)),
      });
  }
}

function describeLoginError(error: unknown): string {
  const { message, retryAfterSeconds } = toApiError(error);
  if (retryAfterSeconds === null) {
    return message;
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `${message} Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
