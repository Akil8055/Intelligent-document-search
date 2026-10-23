import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { searchService } from '../services/searchService.js';

export const searchRouter = Router();

searchRouter.use(authenticate);

const SearchQuerySchema = z.object({
  query: z.string().min(1, 'Search query cannot be empty'),
  mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid'),
  top_k: z.number().int().min(1).max(100).default(10),
  document_ids: z.array(z.string().uuid()).optional(),
  rerank: z.boolean().default(false),
});

searchRouter.post('/search', async (req, res) => {
  const start = Date.now();
  try {
    const validated = SearchQuerySchema.parse(req.body);

    const results = await searchService.search({
      query: validated.query,
      mode: validated.mode,
      topK: validated.top_k,
      userId: req.user!.id,
      documentIds: validated.document_ids,
      rerank: validated.rerank,
    });

    const durationMs = Date.now() - start;

    res.json({
      query: validated.query,
      mode: validated.mode,
      top_k: validated.top_k,
      total_results: results.length,
      latency_ms: durationMs,
      results,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});
