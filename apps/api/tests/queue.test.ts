import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { pool, query } from '../src/db/index.js';
import { queueService } from '../src/services/queueService.js';
import { deleteTestUserData } from './helpers.js';

describe('Milestone 5: Background Ingestion and Reliable Queue Processing', () => {
  let authToken: string;
  let userId: string;
  const samplePdfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/samples/sample_ai_paper.pdf');

  beforeAll(async () => {
    await queueService.initialize();

    const email = `queue-${Date.now()}@docsearch.local`;
    const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'password123' });
    authToken = res.body.token;
    userId = res.body.user.id;
  });

  afterAll(async () => {
    await queueService.shutdown();
    if (userId) await deleteTestUserData(userId);
    await pool.end();
  });

  it('GET /api/v1/queue/status reports health and active provider', async () => {
    const res = await request(app)
      .get('/api/v1/queue/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('provider');
    expect(res.body).toHaveProperty('active_jobs');
    expect(res.body).toHaveProperty('queued_jobs');
  });

  it('POST /api/v1/documents enqueues job and processes asynchronously in background', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', samplePdfPath);

    expect(uploadRes.status).toBe(202);
    expect(uploadRes.body).toHaveProperty('job_id');
    expect(uploadRes.body.document.status).toBe('queued');

    const docId = uploadRes.body.document.id;

    // Poll until completed (timeout after 15 seconds)
    const startTime = Date.now();
    let isCompleted = false;

    while (Date.now() - startTime < 15000) {
      const statusRes = await request(app)
        .get(`/api/v1/documents/${docId}/status`)
        .set('Authorization', `Bearer ${authToken}`);

      if (statusRes.body.status === 'completed') {
        isCompleted = true;
        expect(statusRes.body.page_count).toBe(3);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(isCompleted).toBe(true);

    // Verify search works on the background-indexed document
    const searchRes = await request(app)
      .post('/api/v1/search')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        query: 'Reciprocal Rank Fusion',
        mode: 'hybrid',
      });

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.results.length).toBeGreaterThan(0);
  });
});
