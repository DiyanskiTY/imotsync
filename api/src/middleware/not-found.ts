import type { RequestHandler } from 'express';
import { HttpError } from '../lib/http-error.js';

/** Runs after every route: anything that reaches it becomes a JSON 404. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', `No route matches ${req.method} ${req.path}`));
};
