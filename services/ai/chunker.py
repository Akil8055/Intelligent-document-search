import re
from typing import List, Dict, Any

class DocumentChunker:
    """Splits document pages into semantically coherent overlapping chunks while preserving page numbers and metadata."""

    def __init__(self, chunk_size: int = 500, chunk_overlap: int = 75, embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be strictly less than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.embedding_model = embedding_model

    @staticmethod
    def _split_into_sentences(text: str) -> List[str]:
        """Split text into sentences using regex boundary matching."""
        # Split on sentence terminals followed by whitespace or linebreaks
        sentences = re.split(r'(?<=[.!?])\s+', text)
        return [s.strip() for s in sentences if s.strip()]

    def chunk_pages(self, pages: List[Dict[str, Any]], document_id: str = "") -> List[Dict[str, Any]]:
        """
        Chunks page text sequentially, associating each chunk with its source page.
        """
        chunks: List[Dict[str, Any]] = []
        global_chunk_idx = 0

        for page in pages:
            page_num = page.get("page_number", 1)
            raw_text = page.get("text", "").strip()

            if not raw_text:
                continue

            # Split page text into sentences
            sentences = self._split_into_sentences(raw_text)
            if not sentences:
                sentences = [raw_text]

            current_chunk_words: List[str] = []
            current_word_count = 0

            for sentence in sentences:
                sentence_words = sentence.split()
                if not sentence_words:
                    continue

                # If adding this sentence exceeds chunk_size and we already have words
                if current_word_count + len(sentence_words) > self.chunk_size and current_word_count > 0:
                    chunk_text = " ".join(current_chunk_words).strip()
                    if chunk_text:
                        chunks.append({
                            "document_id": document_id,
                            "chunk_index": global_chunk_idx,
                            "content": chunk_text,
                            "page_number": page_num,
                            "token_count": current_word_count,
                            "embedding_model": self.embedding_model,
                            "metadata": {
                                "page_number": page_num,
                                "source_char_len": len(chunk_text)
                            }
                        })
                        global_chunk_idx += 1

                    # Retain overlap from end of current chunk
                    if self.chunk_overlap > 0 and len(current_chunk_words) > self.chunk_overlap:
                        overlap_words = current_chunk_words[-self.chunk_overlap:]
                        current_chunk_words = list(overlap_words)
                        current_word_count = len(current_chunk_words)
                    else:
                        current_chunk_words = []
                        current_word_count = 0

                current_chunk_words.extend(sentence_words)
                current_word_count += len(sentence_words)

            # Flush remaining words for this page
            if current_chunk_words:
                chunk_text = " ".join(current_chunk_words).strip()
                if chunk_text:
                    chunks.append({
                        "document_id": document_id,
                        "chunk_index": global_chunk_idx,
                        "content": chunk_text,
                        "page_number": page_num,
                        "token_count": current_word_count,
                        "embedding_model": self.embedding_model,
                        "metadata": {
                            "page_number": page_num,
                            "source_char_len": len(chunk_text)
                        }
                    })
                    global_chunk_idx += 1

        return chunks
