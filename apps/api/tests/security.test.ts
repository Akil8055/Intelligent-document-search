import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { pool, query } from '../src/db/index.js';
import { documentService } from '../src/services/documentService.js';
import { config } from '../src/config.js';
import { deleteTestUserData } from './helpers.js';

describe('Milestone 3: Multi-User Security, Authorization, and Idempotency Tests', () => {
  let tokenA: string;
  let userAId: string;
  let tokenB: string;
  let userBId: string;
  let docAId: string;

  const samplePdfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/samples/sample_ai_paper.pdf');

  beforeAll(async () => {
    // Register User A
    const emailA = `user-a-${Date.now()}@docsearch.local`;
    const resA = await request(app).post('/api/v1/auth/register').send({ email: emailA, password: 'password123' });
    tokenA = resA.body.token;
    userAId = resA.body.user.id;

    // Register User B
    const emailB = `user-b-${Date.now()}@docsearch.local`;
    const resB = await request(app).post('/api/v1/auth/register').send({ email: emailB, password: 'password123' });
    tokenB = resB.body.token;
    userBId = resB.body.user.id;

    // User A uploads document
    const uploadRes = await request(app)
      .post('/api/v1/documents?sync=true')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', samplePdfPath);

    expect(uploadRes.status).toBe(201);
    docAId = uploadRes.body.document.id;
  });

  afterAll(async () => {
    if (userAId) await deleteTestUserData(userAId);
    if (userBId) await deleteTestUserData(userBId);
    await pool.end();
  });

  it('User B cannot retrieve User A document details (404/unauthorized)', async () => {
    const res = await request(app)
      .get(`/api/v1/documents/${docAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });

  it('Protected document routes reject missing tokens outside development', async () => {
    const originalEnvironment = config.nodeEnv;
    config.nodeEnv = 'production';
    try {
      const res = await request(app).get('/api/v1/documents');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication token required');
    } finally {
      config.nodeEnv = originalEnvironment;
    }
  });

  it('User B cannot view User A document status', async () => {
    const res = await request(app)
      .get(`/api/v1/documents/${docAId}/status`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });

  it('User B document list does not contain User A document', async () => {
    const res = await request(app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(200);
    const docIds = res.body.documents.map((d: any) => d.id);
    expect(docIds).not.toContain(docAId);
  });

  it('User B cannot delete User A document', async () => {
    const res = await request(app)
      .delete(`/api/v1/documents/${docAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(res.status).toBe(404);
  });

  it('Cross-user isolation: User B search returns 0 results for User A document content', async () => {
    for (const mode of ['keyword', 'semantic', 'hybrid']) {
      const res = await request(app)
        .post('/api/v1/search')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          query: 'Reciprocal Rank Fusion hybrid document search',
          mode,
          top_k: 5,
        });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(0);
    }
  });

  it('Idempotency: Re-processing the same document does NOT duplicate chunks', async () => {
    // Initial chunk count
    const initialChunks = await query(
      'SELECT count(*) as count FROM document_chunks WHERE document_id = $1;',
      [docAId]
    );
    const initialCount = parseInt(initialChunks.rows[0].count, 10);
    expect(initialCount).toBeGreaterThan(0);

    // Re-process the exact same document
    const reprocessed = await documentService.processDocument(docAId);
    expect(reprocessed.status).toBe('completed');

    // Verify chunk count remains identical
    const afterChunks = await query(
      'SELECT count(*) as count FROM document_chunks WHERE document_id = $1;',
      [docAId]
    );
    const afterCount = parseInt(afterChunks.rows[0].count, 10);
    expect(afterCount).toBe(initialCount);
  });

  it('Safe retries: Failed document can be safely retried and recovered', async () => {
    // Artificially set document to failed
    await query(
      `UPDATE documents SET status = 'failed', error_message = 'Simulated transient network timeout' WHERE id = $1;`,
      [docAId]
    );

    const statusRes = await request(app)
      .get(`/api/v1/documents/${docAId}/status`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(statusRes.body.status).toBe('failed');
    expect(statusRes.body.error_message).toBe('Simulated transient network timeout');

    // Trigger retry
    const retryRes = await request(app)
      .post(`/api/v1/documents/${docAId}/retry`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(retryRes.status).toBe(202);
    expect(retryRes.body.document.status).toBe('queued');
    expect(retryRes.body.document.error_message).toBeNull();
  });
});
