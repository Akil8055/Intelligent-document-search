import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { answerService } from '../services/answerService.js';

export const answersRouter = Router();

answersRouter.use(authenticate);

const AnswerRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  document_ids: z.array(z.string().uuid()).optional(),
  min_relevance_score: z.number().min(0.0).max(1.0).optional(),
});

answersRouter.post('/answers', async (req, res) => {
  const start = Date.now();
  try {
    const validated = AnswerRequestSchema.parse(req.body);

    const answerResponse = await answerService.generateAnswer({
      query: validated.query,
      userId: req.user!.id,
      documentIds: validated.document_ids,
      minRelevanceScore: validated.min_relevance_score,
    });

    const durationMs = Date.now() - start;

    res.json({
      ...answerResponse,
      latency_ms: durationMs,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    console.error('Answer generation error:', err);
    res.status(500).json({ error: 'Failed to generate grounded answer', details: err.message });
  }
});
