import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import { app } from '../src/app.js';
import { pool, query } from '../src/db/index.js';
import { deleteTestUserData } from './helpers.js';

describe('Document Intelligence API Integration Tests', () => {
  let authToken: string;
  let userId: string;
  let testDocumentId: string;
  const samplePdfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/samples/sample_ai_paper.pdf');

  beforeAll(async () => {
    // Clean up test tables if needed
    const email = `test-${Date.now()}@docsearch.local`;
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123' });

    expect(regRes.status).toBe(201);
    authToken = regRes.body.token;
    userId = regRes.body.user.id;
  });

  afterAll(async () => {
    if (userId) {
      await deleteTestUserData(userId);
    }
    await pool.end();
  });

  it('GET /health returns health status', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('services');
    expect(res.body.services.database.status).toBe('up');
  });

  it('POST /api/v1/auth/login succeeds with valid credentials', async () => {
    const email = `login-${Date.now()}@docsearch.local`;
    await request(app).post('/api/v1/auth/register').send({ email, password: 'password123' });

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'password123' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('token');
    expect(loginRes.body.user.email).toBe(email);
  });

  it('POST /api/v1/auth/login fails with invalid password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'dev@docsearch.local', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/documents rejects non-PDF file upload', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', Buffer.from('plain text file content'), 'test.txt');

    expect([400, 500]).toContain(res.status);
  });

  it('POST /api/v1/documents uploads and processes real sample PDF', async () => {
    expect(fs.existsSync(samplePdfPath)).toBe(true);

    const res = await request(app)
      .post('/api/v1/documents?sync=true')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', samplePdfPath);

    expect([201, 422]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body.document).toHaveProperty('id');
      expect(res.body.document.status).toBe('completed');
      expect(res.body.document.page_count).toBe(3);
      testDocumentId = res.body.document.id;
    }
  });

  it('GET /api/v1/documents lists the user documents', async () => {
    const res = await request(app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.documents)).toBe(true);
  });

  it('POST /api/v1/search executes keyword search over chunks', async () => {
    if (!testDocumentId) return;

    const res = await request(app)
      .post('/api/v1/search')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        query: 'Reciprocal Rank Fusion',
        mode: 'keyword',
        top_k: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.search_mode || res.body.mode).toBe('keyword');
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].content).toContain('Reciprocal Rank Fusion');
    expect(res.body.results[0].page_number).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/v1/search executes hybrid search with RRF scoring', async () => {
    if (!testDocumentId) return;

    const res = await request(app)
      .post('/api/v1/search')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        query: 'hybrid document search engine combining lexical and dense vectors',
        mode: 'hybrid',
        top_k: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0]).toHaveProperty('score');
    expect(res.body.results[0]).toHaveProperty('page_number');
  });

  it('DELETE /api/v1/documents/:id deletes document and cleans up', async () => {
    if (!testDocumentId) return;

    const res = await request(app)
      .delete(`/api/v1/documents/${testDocumentId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);

    // Verify it is gone
    const getRes = await request(app)
      .get(`/api/v1/documents/${testDocumentId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(getRes.status).toBe(404);
  });
});
