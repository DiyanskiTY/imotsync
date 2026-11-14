import type { Request, RequestHandler } from 'express';
import type { UserRole } from '../../db/types.js';
import { HttpError } from '../../lib/http-error.js';
import { toUserDto, type UserDto } from './auth.mappers.js';
import type { UserRepository } from './auth.repository.js';
import { BEARER_CHALLENGE, InvalidTokenError, type TokenService } from './tokens.js';

/** The signed-in user of a request (set by requireAuth). */
export type AuthUser = UserDto;

const authenticatedUsers = new WeakMap<Request, AuthUser>();

function unauthorized(message: string, invalidToken: boolean): HttpError {
  return new HttpError(401, 'UNAUTHORIZED', message, {
    headers: {
      'WWW-Authenticate': invalidToken
        ? `${BEARER_CHALLENGE}, error="invalid_token"`
        : BEARER_CHALLENGE,
    },
  });
}

/** The token from "Authorization: Bearer <token>", or undefined when there is none. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)[ \t]*$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * Rejects the request with 401 UNAUTHORIZED unless it carries a valid token of a user
 * that still exists. The user's current role comes from the database, so a changed role
 * applies at once and not only after the token expires.
 */
export function createRequireAuth(deps: {
  tokens: TokenService;
  users: UserRepository;
}): RequestHandler {
  const { tokens, users } = deps;

  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (header === undefined || header.trim() === '') {
      throw unauthorized('Authentication required: send "Authorization: Bearer <token>"', false);
    }
    const token = bearerToken(header);
    if (!token) {
      throw unauthorized('Authorization header must be "Bearer <token>"', true);
    }

    let userId: number;
    try {
      ({ userId } = await tokens.verify(token));
    } catch (error) {
      if (error instanceof InvalidTokenError) throw unauthorized(error.message, true);
      throw error;
    }

    const user = await users.findById(userId);
    if (!user) {
      throw unauthorized('The account of this token no longer exists', true);
    }
    authenticatedUsers.set(req, toUserDto(user));
    next();
  };
}

/** The signed-in user. Only valid behind requireAuth; anything else is a wiring bug. */
export function currentUser(req: Request): AuthUser {
  const user = authenticatedUsers.get(req);
  if (!user) {
    throw new Error('currentUser() called on a route that is not behind requireAuth');
  }
  return user;
}

/** 403 FORBIDDEN unless the signed-in user has one of the roles. Use after requireAuth. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = authenticatedUsers.get(req);
    if (!user) {
      throw unauthorized('Authentication required: send "Authorization: Bearer <token>"', false);
    }
    if (!roles.includes(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', `This action requires the role: ${roles.join(' or ')}`);
    }
    next();
  };
}
