import { errors, jwtVerify, SignJWT } from 'jose';
import { USER_ROLES, type UserRole } from '../../db/types.js';

/*
 * Login tokens: JWTs signed with HS256 and JWT_SECRET. Verification pins the algorithm,
 * the token type, the issuer and the audience, so a token minted for another service, an
 * unsigned ("alg": "none") token or one signed with another algorithm is refused.
 */

export const TOKEN_ISSUER = 'imotsync';
export const TOKEN_AUDIENCE = 'imotsync-api';
export const TOKEN_ALGORITHM = 'HS256';

/** RFC 6750 challenge: every 401 names the Bearer scheme in WWW-Authenticate. */
export const BEARER_CHALLENGE = 'Bearer realm="imotsync"';
const TOKEN_TYPE = 'JWT';

export interface TokenClaims {
  userId: number;
  role: UserRole;
}

export interface IssuedToken {
  token: string;
  /** Lifetime in seconds. */
  expiresIn: number;
}

export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';

  constructor(
    message: string,
    /** True when the token was valid but its exp has passed. */
    readonly expired = false,
  ) {
    super(message);
  }
}

export interface TokenService {
  sign(claims: TokenClaims): Promise<IssuedToken>;
  /** Resolves with the claims, or rejects with InvalidTokenError. */
  verify(token: string): Promise<TokenClaims>;
}

export interface TokenServiceOptions {
  secret: string;
  ttlSeconds: number;
  /** Clock in milliseconds; tests move it to produce expired tokens. */
  now?: () => number;
}

const isRole = (value: unknown): value is UserRole =>
  typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);

export function createTokenService({
  secret,
  ttlSeconds,
  now = Date.now,
}: TokenServiceOptions): TokenService {
  const key = new TextEncoder().encode(secret);

  return {
    async sign({ userId, role }) {
      const issuedAt = Math.floor(now() / 1000);
      const token = await new SignJWT({ role })
        .setProtectedHeader({ alg: TOKEN_ALGORITHM, typ: TOKEN_TYPE })
        .setSubject(String(userId))
        .setIssuer(TOKEN_ISSUER)
        .setAudience(TOKEN_AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(key);
      return { token, expiresIn: ttlSeconds };
    },

    async verify(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: [TOKEN_ALGORITHM],
          typ: TOKEN_TYPE,
          issuer: TOKEN_ISSUER,
          audience: TOKEN_AUDIENCE,
          requiredClaims: ['sub', 'iat', 'exp'],
          currentDate: new Date(now()),
        }));
      } catch (error) {
        if (error instanceof errors.JWTExpired) {
          throw new InvalidTokenError('Token has expired', true);
        }
        throw new InvalidTokenError('Invalid token');
      }

      const { sub, role } = payload;
      if (typeof sub !== 'string' || !/^[1-9]\d{0,9}$/.test(sub) || !isRole(role)) {
        throw new InvalidTokenError('Invalid token');
      }
      return { userId: Number(sub), role };
    },
  };
}
