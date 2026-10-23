import { Router } from 'express';
import { checkDatabaseHealth } from '../db/index.js';
import { aiClient } from '../services/aiService.js';

export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  const [dbHealthy, aiHealth] = await Promise.all([
    checkDatabaseHealth(),
    aiClient.checkHealth(),
  ]);

  const allHealthy = dbHealthy && aiHealth.healthy;

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      api: { status: 'up' },
      database: { status: dbHealthy ? 'up' : 'down' },
      aiService: {
        status: aiHealth.healthy ? 'up' : 'down',
        details: aiHealth.details,
      },
    },
  });
});
