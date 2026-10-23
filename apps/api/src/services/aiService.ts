import { config } from '../config.js';

export interface ExtractedPage {
  page_number: number;
  text: string;
  char_count: number;
  word_count: number;
  is_empty: boolean;
}

export interface ExtractionResult {
  file_path: string;
  metadata: Record<string, any>;
  page_count: number;
  total_char_count: number;
  is_scanned: boolean;
  status_message: string;
  pages: ExtractedPage[];
}

export interface ChunkItem {
  document_id: string;
  chunk_index: number;
  content: string;
  page_number: number;
  token_count: number;
  embedding_model: string;
  metadata: Record<string, any>;
}

export interface VectorMatch {
  chunk_id: string;
  document_id: string;
  score: number;
}

export class AIServiceClient {
  private baseUrl: string;

  constructor(baseUrl: string = config.aiServiceUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async checkHealth(): Promise<{ healthy: boolean; details?: any }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        return { healthy: true, details: data };
      }
      return { healthy: false };
    } catch (err: any) {
      return { healthy: false, details: err.message };
    }
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const res = await fetch(`${this.baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Extraction failed' }));
      throw new Error(`AI Service extraction failed: ${err.detail || res.statusText}`);
    }

    return res.json() as Promise<ExtractionResult>;
  }

  async chunk(
    documentId: string,
    pages: ExtractedPage[],
    chunkSize?: number,
    chunkOverlap?: number
  ): Promise<ChunkItem[]> {
    const res = await fetch(`${this.baseUrl}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document_id: documentId,
        pages,
        chunk_size: chunkSize,
        chunk_overlap: chunkOverlap,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Chunking failed' }));
      throw new Error(`AI Service chunking failed: ${err.detail || res.statusText}`);
    }

    const data = await res.json() as { chunks: ChunkItem[] };
    return data.chunks;
  }

  async indexChunks(
    chunks: Array<{ chunk_id: string; document_id: string; content: string; embedding?: number[] }>
  ): Promise<{ indexed_count: number; total_indexed: number }> {
    const res = await fetch(`${this.baseUrl}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunks }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Indexing failed' }));
      throw new Error(`AI Service indexing failed: ${err.detail || res.statusText}`);
    }

    return res.json() as Promise<{ indexed_count: number; total_indexed: number }>;
  }

  async search(
    query: string,
    topK: number = 10,
    allowedChunkIds?: string[]
  ): Promise<VectorMatch[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        top_k: topK,
        allowed_chunk_ids: allowedChunkIds,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Vector search failed' }));
      throw new Error(`AI Service vector search failed: ${err.detail || res.statusText}`);
    }

    const data = await res.json() as { matches: VectorMatch[] };
    return data.matches;
  }

  async deleteDocumentVectors(documentId: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/index/document/${documentId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Deletion failed' }));
      throw new Error(`AI Service vector deletion failed: ${err.detail || res.statusText}`);
    }

    const data = await res.json() as { deleted_count: number };
    return data.deleted_count;
  }

  async reconcileVectors(validChunkIds: string[]): Promise<{ removed_count: number; total_indexed: number }> {
    const res = await fetch(`${this.baseUrl}/index/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid_chunk_ids: validChunkIds }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Vector reconciliation failed' }));
      throw new Error(`AI Service vector reconciliation failed: ${err.detail || res.statusText}`);
    }

    return res.json() as Promise<{ removed_count: number; total_indexed: number }>;
  }

  async rerank(
    query: string,
    passages: string[],
    topK: number = 5
  ): Promise<Array<{ original_index: number; score: number; logit: number }>> {
    const res = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, passages, top_k: topK }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Reranking failed' }));
      throw new Error(`AI Service reranking failed: ${err.detail || res.statusText}`);
    }

    const data = await res.json() as { results: Array<{ original_index: number; score: number; logit: number }> };
    return data.results;
  }
}

export const aiClient = new AIServiceClient();
