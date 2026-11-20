import type { UserRow } from '../../db/types.js';
import { HttpError } from '../../lib/http-error.js';
import { verifyPassword } from '../../lib/password.js';
import { toUserDto, type LoginResponse } from './auth.mappers.js';
import type { UserRepository } from './auth.repository.js';
import { BEARER_CHALLENGE, type TokenService } from './tokens.js';

/**
 * A valid scrypt hash (of a throw-away password) with the same parameters hashPassword()
 * uses today. A login with an unknown email is checked against it, so it costs the same
 * scrypt run as a wrong password and the response time does not reveal which emails exist.
 */
export const DUMMY_PASSWORD_HASH =
  '$scrypt$ln=15,r=8,p=3$ofPLtdzpKUIy+kT3Z7dFLQ$Z8HxeIJF+gDSlH3suxRDI34MUD4MyEq1l6KPI8bGsBg';

export const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect';

/** Emails are compared trimmed and lower-cased. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface AuthService {
  login(email: string, password: string): Promise<LoginResponse>;
}

/** The login response for a user who has proved who they are. */
export async function issueSession(tokens: TokenService, user: UserRow): Promise<LoginResponse> {
  const { token, expiresIn } = await tokens.sign({ userId: user.id, role: user.role });
  return { accessToken: token, tokenType: 'Bearer', expiresIn, user: toUserDto(user) };
}

export function createAuthService(deps: {
  users: UserRepository;
  tokens: TokenService;
}): AuthService {
  const { users, tokens } = deps;

  return {
    async login(email, password) {
      const user = await users.findByEmail(normalizeEmail(email));
      // Always one scrypt run, whether or not the account exists.
      const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordOk) {
        // Like every 401, it names the scheme the API expects (RFC 9110, section 15.5.2).
        throw new HttpError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE, {
          headers: { 'WWW-Authenticate': BEARER_CHALLENGE },
        });
      }

      return issueSession(tokens, user);
    },
  };
}
