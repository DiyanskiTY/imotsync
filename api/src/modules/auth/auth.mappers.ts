import type { UserRole, UserRow } from '../../db/types.js';

/** A user as the API returns it (never the password hash). */
export interface UserDto {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Token lifetime in seconds. */
  expiresIn: number;
  user: UserDto;
}

export function toUserDto(row: Pick<UserRow, 'id' | 'email' | 'full_name' | 'role'>): UserDto {
  return { id: row.id, email: row.email, fullName: row.full_name, role: row.role };
}
