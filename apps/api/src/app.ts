import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { searchRouter } from './routes/search.js';
import { answersRouter } from './routes/answers.js';

export const app = express();

// Security and utility middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint (root level)
app.use(healthRouter);

// Versioned API endpoints
const apiV1 = express.Router();
apiV1.use(authRouter);
apiV1.use(documentsRouter);
apiV1.use(searchRouter);
apiV1.use(answersRouter);

app.use('/api/v1', apiV1);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Centralized error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled server error:', err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
});
