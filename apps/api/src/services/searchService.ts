import { query } from '../db/index.js';
import { aiClient } from './aiService.js';

export interface SearchResultItem {
  chunk_id: string;
  document_id: string;
  document_name: string;
  page_number: number;
  chunk_index: number;
  content: string;
  score: number;
  search_mode: 'keyword' | 'semantic' | 'hybrid';
  details?: {
    keyword_rank?: number;
    keyword_score?: number;
    semantic_rank?: number;
    semantic_score?: number;
    rrf_score?: number;
  };
}

export interface SearchOptions {
  query: string;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  topK?: number;
  userId?: string;
  documentIds?: string[];
  rerank?: boolean;
}

export class SearchService {
  /**
   * Keyword-only search using PostgreSQL Full-Text Search (tsvector + ts_rank_cd)
   */
  async keywordSearch(
    searchQuery: string,
    topK: number = 10,
    userId?: string,
    documentIds?: string[]
  ): Promise<SearchResultItem[]> {
    // Sanitize and prepare query
    const trimmed = searchQuery.trim();
    if (!trimmed) return [];

    let sql = `
      SELECT 
        c.id as chunk_id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.page_number,
        c.metadata,
        d.original_name as document_name,
        ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) as score
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.tsv @@ websearch_to_tsquery('english', $1)
    `;

    const params: any[] = [trimmed];

    if (userId) {
      params.push(userId);
      sql += ` AND d.user_id = $${params.length}`;
    }

    if (documentIds && documentIds.length > 0) {
      params.push(documentIds);
      sql += ` AND c.document_id = ANY($${params.length}::uuid[])`;
    }

    params.push(topK);
    sql += ` ORDER BY score DESC LIMIT $${params.length};`;

    const res = await query(sql, params);

    // If websearch_to_tsquery didn't match anything, try plainto_tsquery as fallback for partial keywords
    if (res.rows.length === 0) {
      let fallbackSql = `
        SELECT 
          c.id as chunk_id,
          c.document_id,
          c.chunk_index,
          c.content,
          c.page_number,
          c.metadata,
          d.original_name as document_name,
          ts_rank_cd(c.tsv, plainto_tsquery('english', $1)) as score
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.tsv @@ plainto_tsquery('english', $1)
      `;
      const fallbackParams: any[] = [trimmed];
      if (userId) {
        fallbackParams.push(userId);
        fallbackSql += ` AND d.user_id = $${fallbackParams.length}`;
      }
      if (documentIds && documentIds.length > 0) {
        fallbackParams.push(documentIds);
        fallbackSql += ` AND c.document_id = ANY($${fallbackParams.length}::uuid[])`;
      }
      fallbackParams.push(topK);
      fallbackSql += ` ORDER BY score DESC LIMIT $${fallbackParams.length};`;

      const fallbackRes = await query(fallbackSql, fallbackParams);
      return fallbackRes.rows.map((row: any) => ({
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        document_name: row.document_name,
        page_number: row.page_number,
        chunk_index: row.chunk_index,
        content: row.content,
        score: parseFloat(row.score) || 0,
        search_mode: 'keyword',
      }));
    }

    return res.rows.map((row: any) => ({
      chunk_id: row.chunk_id,
      document_id: row.document_id,
      document_name: row.document_name,
      page_number: row.page_number,
      chunk_index: row.chunk_index,
      content: row.content,
      score: parseFloat(row.score) || 0,
      search_mode: 'keyword',
    }));
  }

  /**
   * Semantic-only search using Sentence Transformers and FAISS cosine similarity
   */
  async semanticSearch(
    searchQuery: string,
    topK: number = 10,
    userId?: string,
    documentIds?: string[]
  ): Promise<SearchResultItem[]> {
    const trimmed = searchQuery.trim();
    if (!trimmed) return [];

    // Get allowed chunk IDs if filtering by user or documents
    let allowedChunkIds: string[] | undefined = undefined;
    if (userId || (documentIds && documentIds.length > 0)) {
      let filterSql = `
        SELECT c.id
        FROM document_chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE 1=1
      `;
      const filterParams: any[] = [];
      if (userId) {
        filterParams.push(userId);
        filterSql += ` AND d.user_id = $${filterParams.length}`;
      }
      if (documentIds && documentIds.length > 0) {
        filterParams.push(documentIds);
        filterSql += ` AND c.document_id = ANY($${filterParams.length}::uuid[])`;
      }

      const allowedRes = await query<{ id: string }>(filterSql, filterParams);
      allowedChunkIds = allowedRes.rows.map((r) => r.id);
      if (allowedChunkIds.length === 0) {
        return [];
      }
    }

    const matches = await aiClient.search(trimmed, topK, allowedChunkIds);
    if (matches.length === 0) {
      return [];
    }

    // Hydrate matches with PostgreSQL chunk content, document names, and page numbers
    const chunkIds = matches.map((m) => m.chunk_id);
    const scoreMap = new Map<string, number>(matches.map((m) => [m.chunk_id, m.score]));

    const hydrateSql = `
      SELECT 
        c.id as chunk_id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.page_number,
        d.original_name as document_name
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.id = ANY($1::uuid[]);
    `;

    const res = await query(hydrateSql, [chunkIds]);
    const rowMap = new Map<string, any>(res.rows.map((r: any) => [r.chunk_id, r]));

    // Preserve ranking order from FAISS matches
    const results: SearchResultItem[] = [];
    for (const match of matches) {
      const row = rowMap.get(match.chunk_id);
      if (row) {
        results.push({
          chunk_id: row.chunk_id,
          document_id: row.document_id,
          document_name: row.document_name,
          page_number: row.page_number,
          chunk_index: row.chunk_index,
          content: row.content,
          score: match.score,
          search_mode: 'semantic',
        });
      }
    }

    return results;
  }

  /**
   * Hybrid search using Reciprocal Rank Fusion (RRF)
   */
  async hybridSearch(
    searchQuery: string,
    topK: number = 10,
    userId?: string,
    documentIds?: string[]
  ): Promise<SearchResultItem[]> {
    const candidateK = Math.max(topK * 3, 30);

    // Run keyword and semantic searches concurrently
    const [keywordResults, semanticResults] = await Promise.all([
      this.keywordSearch(searchQuery, candidateK, userId, documentIds),
      this.semanticSearch(searchQuery, candidateK, userId, documentIds),
    ]);

    // RRF constant k=60
    const RRF_K = 60;
    const scores = new Map<
      string,
      {
        item: SearchResultItem;
        keywordRank?: number;
        keywordScore?: number;
        semanticRank?: number;
        semanticScore?: number;
        rrfScore: number;
      }
    >();

    // Process keyword rankings
    keywordResults.forEach((item, index) => {
      const rank = index + 1;
      const rrfContribution = 1 / (RRF_K + rank);
      scores.set(item.chunk_id, {
        item,
        keywordRank: rank,
        keywordScore: item.score,
        rrfScore: rrfContribution,
      });
    });

    // Process semantic rankings
    semanticResults.forEach((item, index) => {
      const rank = index + 1;
      const rrfContribution = 1 / (RRF_K + rank);
      const existing = scores.get(item.chunk_id);
      if (existing) {
        existing.semanticRank = rank;
        existing.semanticScore = item.score;
        existing.rrfScore += rrfContribution;
      } else {
        scores.set(item.chunk_id, {
          item,
          semanticRank: rank,
          semanticScore: item.score,
          rrfScore: rrfContribution,
        });
      }
    });

    // Sort by RRF score descending
    const sorted = Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore);

    return sorted.slice(0, topK).map((entry) => ({
      ...entry.item,
      score: entry.rrfScore,
      search_mode: 'hybrid',
      details: {
        keyword_rank: entry.keywordRank,
        keyword_score: entry.keywordScore,
        semantic_rank: entry.semanticRank,
        semantic_score: entry.semanticScore,
        rrf_score: entry.rrfScore,
      },
    }));
  }

  async search(options: SearchOptions): Promise<SearchResultItem[]> {
    const mode = options.mode || 'hybrid';
    const topK = options.topK || 10;
    const shouldRerank = options.rerank ?? false;
    const initialK = shouldRerank ? Math.max(topK * 2, 10) : topK;

    let baseResults: SearchResultItem[];
    switch (mode) {
      case 'keyword':
        baseResults = await this.keywordSearch(options.query, initialK, options.userId, options.documentIds);
        break;
      case 'semantic':
        baseResults = await this.semanticSearch(options.query, initialK, options.userId, options.documentIds);
        break;
      case 'hybrid':
      default:
        baseResults = await this.hybridSearch(options.query, initialK, options.userId, options.documentIds);
        break;
    }

    if (!shouldRerank || baseResults.length === 0) {
      return baseResults.slice(0, topK);
    }

    try {
      const passages = baseResults.map((r) => r.content);
      const reranked = await aiClient.rerank(options.query, passages, topK);

      return reranked.flatMap((item) => {
        const orig = baseResults[item.original_index];
        if (!orig || !Number.isFinite(item.score)) {
          return [];
        }
        return {
          ...orig,
          score: item.score,
          details: {
            ...orig.details,
            reranker_score: item.score,
            reranker_logit: item.logit,
          },
        };
      });
    } catch (err: any) {
      console.warn('Reranker failed, falling back to base ranking:', err.message);
      return baseResults.slice(0, topK);
    }
  }
}

export const searchService = new SearchService();
