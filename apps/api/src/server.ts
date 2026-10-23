import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db/index.js';
import { ensureDefaultUser } from './middleware/auth.js';
import { queueService } from './services/queueService.js';
import { aiClient } from './services/aiService.js';
import { query } from './db/index.js';

async function startServer() {
  try {
    // The fixed development account is never created in production.
    if (config.nodeEnv === 'development') {
      await ensureDefaultUser();
      console.log('Database connection and default development user ready.');
    } else {
      await pool.query('SELECT 1');
      console.log('Database connection ready.');
    }

    // PostgreSQL is authoritative for chunk existence. Prune vectors orphaned by
    // prior deletions or interrupted test runs before accepting retrieval traffic.
    try {
      const chunkRows = await query<{ id: string }>('SELECT id FROM document_chunks');
      const reconciliation = await aiClient.reconcileVectors(chunkRows.rows.map((row) => row.id));
      if (reconciliation.removed_count > 0) {
        console.log(`Removed ${reconciliation.removed_count} stale FAISS vectors.`);
      }
    } catch (error) {
      console.warn('FAISS reconciliation was skipped because the AI service is unavailable.');
    }

    // Initialize background queue worker (BullMQ or local fallback)
    await queueService.initialize();

    const server = app.listen(config.port, () => {
      console.log(`Document Search API server running on http://127.0.0.1:${config.port}`);
      console.log(`AI Service target URL: ${config.aiServiceUrl}`);
    });

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
      await queueService.shutdown();
      server.close(async () => {
        console.log('HTTP server closed.');
        await pool.end();
        console.log('PostgreSQL connection pool closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
