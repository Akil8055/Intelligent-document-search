import fs from 'fs/promises';
import path from 'path';
import { query, pool } from '../db/index.js';
import { aiClient } from './aiService.js';
import { config } from '../config.js';

export interface DocumentRecord {
  id: string;
  user_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  page_count: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export class DocumentService {
  async createDocument(data: {
    userId: string;
    filename: string;
    originalName: string;
    mimeType: string;
    fileSize: number;
  }): Promise<DocumentRecord> {
    const sql = `
      INSERT INTO documents (user_id, filename, original_name, mime_type, file_size, status)
      VALUES ($1, $2, $3, $4, $5, 'queued')
      RETURNING *;
    `;
    const res = await query<DocumentRecord>(sql, [
      data.userId,
      data.filename,
      data.originalName,
      data.mimeType,
      data.fileSize,
    ]);
    return res.rows[0];
  }

  async getDocumentById(id: string, userId?: string): Promise<DocumentRecord | null> {
    let sql = `SELECT * FROM documents WHERE id = $1`;
    const params: any[] = [id];
    if (userId) {
      params.push(userId);
      sql += ` AND user_id = $2`;
    }
    const res = await query<DocumentRecord>(sql, params);
    return res.rows[0] || null;
  }

  async listDocuments(userId: string): Promise<DocumentRecord[]> {
    const sql = `SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at DESC;`;
    const res = await query<DocumentRecord>(sql, [userId]);
    return res.rows;
  }

  /**
   * Process document: extract, chunk, store in DB, index in FAISS.
   * Completely idempotent: if retried, chunk unique constraint prevents duplicates.
   */
  async processDocument(documentId: string): Promise<DocumentRecord> {
    // 1. Fetch document
    const docRes = await query<DocumentRecord>(`SELECT * FROM documents WHERE id = $1;`, [documentId]);
    const doc = docRes.rows[0];
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    // 2. Mark processing
    await query(`UPDATE documents SET status = 'processing', updated_at = NOW() WHERE id = $1;`, [documentId]);

    const filePath = path.join(config.uploadDir, doc.filename);

    try {
      // 3. Extract text
      const extraction = await aiClient.extract(filePath);

      if (extraction.is_scanned) {
        const errMsg = 'Document appears to be scanned or image-based with no extractable text layer. OCR is required.';
        await query(
          `UPDATE documents SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2;`,
          [errMsg, documentId]
        );
        throw new Error(errMsg);
      }

      // 4. Chunk document text
      const chunks = await aiClient.chunk(documentId, extraction.pages);
      if (chunks.length === 0) {
        throw new Error('No text chunks could be extracted from this document.');
      }

      // 5. Save chunks into PostgreSQL within transaction with idempotency
      const client = await pool.connect();
      const chunksWithIds: Array<{
        chunk_id: string;
        document_id: string;
        content: string;
      }> = [];

      try {
        await client.query('BEGIN');

        for (const chunk of chunks) {
          const insertChunkSql = `
            INSERT INTO document_chunks (
              document_id, chunk_index, content, page_number, token_count, embedding_model, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (document_id, chunk_index) DO UPDATE
            SET content = EXCLUDED.content,
                page_number = EXCLUDED.page_number,
                token_count = EXCLUDED.token_count,
                metadata = EXCLUDED.metadata
            RETURNING id;
          `;

          const chunkRes = await client.query(insertChunkSql, [
            documentId,
            chunk.chunk_index,
            chunk.content,
            chunk.page_number,
            chunk.token_count,
            chunk.embedding_model,
            JSON.stringify(chunk.metadata || {}),
          ]);

          chunksWithIds.push({
            chunk_id: chunkRes.rows[0].id,
            document_id: documentId,
            content: chunk.content,
          });
        }

        // A document may be replaced or reprocessed into fewer chunks. Remove old
        // chunk rows so keyword and semantic retrieval agree on the current version.
        const activeChunkIndices = chunks.map((chunk) => chunk.chunk_index);
        await client.query(
          `DELETE FROM document_chunks
           WHERE document_id = $1 AND NOT (chunk_index = ANY($2::int[]));`,
          [documentId, activeChunkIndices]
        );

        await client.query(
          `UPDATE documents 
           SET status = 'processing',
               page_count = $1,
               metadata = $2,
               updated_at = NOW()
           WHERE id = $3;`,
          [extraction.page_count, JSON.stringify(extraction.metadata || {}), documentId]
        );

        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        throw dbErr;
      } finally {
        client.release();
      }

      // 6. Replace all document vectors so retries cannot leave stale chunk vectors behind.
      await aiClient.deleteDocumentVectors(documentId);
      await aiClient.indexChunks(chunksWithIds);

      // 7. Mark completed
      const updated = await query<DocumentRecord>(
        `UPDATE documents SET status = 'completed', error_message = NULL, updated_at = NOW() WHERE id = $1 RETURNING *;`,
        [documentId]
      );

      return updated.rows[0];
    } catch (err: any) {
      await query(
        `UPDATE documents SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2;`,
        [err.message || 'Unknown processing error', documentId]
      );
      throw err;
    }
  }

  /**
   * Delete document, files, database records, and vector indices.
   */
  async deleteDocument(id: string, userId: string): Promise<boolean> {
    const doc = await this.getDocumentById(id, userId);
    if (!doc) {
      return false;
    }

    // 1. Delete physical file if present
    const filePath = path.join(config.uploadDir, doc.filename);
    try {
      await fs.unlink(filePath);
    } catch (e: any) {
      // Ignore file-not-found on disk
    }

    // 2. Delete vectors from FAISS
    try {
      await aiClient.deleteDocumentVectors(id);
    } catch (e: any) {
      console.warn(`Warning: Could not remove vectors from FAISS for document ${id}:`, e.message);
    }

    // 3. Delete from PostgreSQL (CASCADE cleans document_chunks and ingestion_jobs)
    await query(`DELETE FROM documents WHERE id = $1 AND user_id = $2;`, [id, userId]);

    return true;
  }
}

export const documentService = new DocumentService();
