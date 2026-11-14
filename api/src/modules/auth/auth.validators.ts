import { body } from 'express-validator';

const isString = (value: unknown) => typeof value === 'string';

/** POST /auth/login {email, password}. */
export const loginValidators = [
  body('email')
    .exists()
    .withMessage('is required')
    .bail()
    .custom(isString)
    .withMessage('must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('is required')
    .bail()
    .isLength({ max: 255 })
    .withMessage('must be at most 255 characters'),
  body('password')
    .exists()
    .withMessage('is required')
    .bail()
    .custom(isString)
    .withMessage('must be a string')
    .bail()
    .isLength({ min: 1, max: 1024 })
    .withMessage('must be 1 to 1024 characters'),
];

export interface LoginBody {
  email: string;
  password: string;
}
