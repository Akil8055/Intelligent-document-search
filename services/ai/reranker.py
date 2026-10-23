import os
import math
from typing import List, Dict, Any, Tuple
from sentence_transformers import CrossEncoder
from config import settings

os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

def sigmoid(x: float) -> float:
    """Map logits monotonically to [0, 1] for display and thresholding.

    This transform does not calibrate the model output as a probability.
    """
    return 1.0 / (1.0 + math.exp(-max(min(x, 15.0), -15.0)))

class RerankerEngine:
    """Manages passage reranking using cross-encoder architecture."""

    _instance = None
    _model = None

    def __init__(self, model_name: str = settings.RERANKER_MODEL):
        self.model_name = model_name
        if RerankerEngine._model is None:
            print(f"Loading Cross-Encoder reranker: {self.model_name}...")
            RerankerEngine._model = CrossEncoder(self.model_name)
            print("Cross-Encoder reranker loaded successfully.")
        self.model = RerankerEngine._model

    def rerank(self, query: str, passages: List[str], top_k: int = 5) -> List[Dict[str, Any]]:
        """
        Computes cross-attention relevance scores for (query, passage) pairs.
        The sigmoid score is a transformed ranking signal, not a probability.
        Returns sorted list of { "original_index": int, "score": float, "logit": float }.
        """
        if not passages:
            return []

        pairs = [[query, passage] for passage in passages]
        raw_scores = self.model.predict(pairs)

        results = []
        for idx, logit in enumerate(raw_scores):
            score_float = float(logit)
            prob_score = sigmoid(score_float)
            results.append({
                "original_index": idx,
                "score": round(prob_score, 4),
                "logit": round(score_float, 4)
            })

        # Sort descending by score
        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]
