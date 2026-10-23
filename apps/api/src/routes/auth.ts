import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/index.js';
import rateLimit from 'express-rate-limit';
import { hashPassword, comparePassword, generateToken, requireAuth, AuthUser } from '../middleware/auth.js';

export const authRouter = Router();

// Rate limiter for authentication: 30 requests per 15 minutes window
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.use('/auth', authLimiter);

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

authRouter.post('/auth/register', async (req, res) => {
  try {
    const { email, password } = RegisterSchema.parse(req.body);

    const existing = await query('SELECT id FROM users WHERE email = $1;', [email]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'User with this email already exists' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const result = await query<AuthUser>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'user')
       RETURNING id, email, role;`,
      [email, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    res.status(201).json({
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, role: user.role },
      token,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

authRouter.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);

    const result = await query<{ id: string; email: string; role: string; password_hash: string }>(
      'SELECT id, email, role, password_hash FROM users WHERE email = $1;',
      [email]
    );

    const user = result.rows[0];
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const matches = await comparePassword(password, user.password_hash);
    if (!matches) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const authUser: AuthUser = { id: user.id, email: user.email, role: user.role };
    const token = generateToken(authUser);

    res.json({
      message: 'Login successful',
      user: authUser,
      token,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
