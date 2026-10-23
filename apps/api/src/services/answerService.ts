import { searchService, SearchResultItem } from './searchService.js';

export interface Citation {
  citation_id: number;
  document_id: string;
  document_name: string;
  page_number: number;
  chunk_index: number;
  quoted_passage: string;
  relevance_score: number;
}

export interface GroundedAnswerResponse {
  query: string;
  answer: string;
  has_sufficient_evidence: boolean;
  evidence_score: number;
  mode: 'grounded-extractive';
  citations: Citation[];
}

export class AnswerService {
  /**
   * Minimum transformed reranker score for returning source passages.
   * This score is useful for ranking and gating, but is not a calibrated probability.
   */
  private readonly MIN_RELEVANCE_THRESHOLD = this.readRelevanceThreshold();

  private readRelevanceThreshold(): number {
    const raw = process.env.ANSWER_MIN_RELEVANCE_SCORE?.trim();
    if (!raw) return 0.25;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : 0.25;
  }

  private toRetrievalQuery(query: string): string {
    const cleaned = query
      .replace(
        /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|previous|prior|above|earlier)\s+){0,4}(?:instructions?|directions?|rules?|prompts?)\b[:,.!;\s]*/gi,
        ' '
      )
      .replace(/^\s*(?:and\s+)?(?:please\s+)?(?:tell me about|explain|describe|summarize)\s+/i, '')
      .trim();

    return cleaned || query;
  }

  /**
   * Extract the most salient sentences/clauses relevant to the query from chunk text.
   */
  private extractRelevantSentences(content: string, queryWords: string[]): string {
    // Split on newlines, bullet points, or sentence terminals
    const lines = content
      .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10);

    if (lines.length === 0) {
      return content.slice(0, 300);
    }

    // Common stop words to exclude when scoring
    const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'in', 'to', 'for', 'of', 'are', 'what', 'how']);

    const scored = lines.map((line) => {
      const lower = line.toLowerCase();
      let matchCount = 0;
      for (const w of queryWords) {
        if (!stopWords.has(w) && w.length > 2 && lower.includes(w)) {
          matchCount++;
        }
      }
      return { line, matchCount };
    });

    scored.sort((a, b) => b.matchCount - a.matchCount);

    // Pick top matching lines
    const top = scored.filter((s) => s.matchCount > 0).slice(0, 2);
    if (top.length > 0) {
      return top.map((s) => s.line).join(' ');
    }
    return lines[0];
  }

  async generateAnswer(params: {
    query: string;
    userId: string;
    documentIds?: string[];
    minRelevanceScore?: number;
  }): Promise<GroundedAnswerResponse> {
    const rawQuery = params.query.trim();
    const retrievalQuery = this.toRetrievalQuery(rawQuery);
    const threshold = params.minRelevanceScore ?? this.MIN_RELEVANCE_THRESHOLD;

    // 1. Retrieve candidates using hybrid retrieval with Cross-Encoder reranking
    const results = await searchService.search({
      query: retrievalQuery,
      mode: 'hybrid',
      rerank: true,
      topK: 5,
      userId: params.userId,
      documentIds: params.documentIds,
    });

    const topScore = results.length > 0 ? results[0].score : 0.0;

    // 2. Insufficient Evidence Detection
    if (results.length === 0 || topScore < threshold) {
      return {
        query: rawQuery,
        answer: 'Insufficient evidence found in the indexed documents to answer this question.',
        has_sufficient_evidence: false,
        evidence_score: topScore,
        mode: 'grounded-extractive',
        citations: [],
      };
    }

    // 3. Extract grounded evidence from top relevant candidates
    const queryTokens = rawQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const qualifying = results.filter((r) => r.score >= threshold);

    const citations: Citation[] = [];
    const answerFragments: string[] = [];

    qualifying.slice(0, 3).forEach((item, idx) => {
      const citationId = idx + 1;
      // There is no generative model in this path. Keep source text intact so citations
      // remain faithful, and treat it only as data to be displayed, never instructions.
      const excerpt = this.extractRelevantSentences(item.content, queryTokens);

      citations.push({
        citation_id: citationId,
        document_id: item.document_id,
        document_name: item.document_name,
        page_number: item.page_number,
        chunk_index: item.chunk_index,
        quoted_passage: excerpt,
        relevance_score: item.score,
      });

      answerFragments.push(`${excerpt} [${citationId}]`);
    });

    return {
      query: rawQuery,
      answer: answerFragments.join(' '),
      has_sufficient_evidence: true,
      evidence_score: topScore,
      mode: 'grounded-extractive',
      citations,
    };
  }
}

export const answerService = new AnswerService();
