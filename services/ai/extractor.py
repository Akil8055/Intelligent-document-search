import os
from typing import Dict, List, Any
import pymupdf  # PyMuPDF

class PDFExtractionError(Exception):
    """Custom exception for PDF extraction issues."""
    pass

class ScannedPDFError(PDFExtractionError):
    """Exception raised when a PDF appears to be scanned/image-only without an OCR text layer."""
    pass

class PDFExtractor:
    """Handles PDF validation, text extraction, page tracking, and scanned-document detection."""

    @staticmethod
    def extract_from_file(file_path: str) -> Dict[str, Any]:
        if not os.path.exists(file_path):
            raise PDFExtractionError(f"File not found: {file_path}")

        if not file_path.lower().endswith(".pdf"):
            raise PDFExtractionError(f"Unsupported file type. Expected PDF, got: {file_path}")

        try:
            doc = pymupdf.open(file_path)
        except Exception as e:
            raise PDFExtractionError(f"Malformed or corrupted PDF file: {str(e)}")

        page_count = len(doc)
        if page_count == 0:
            doc.close()
            raise PDFExtractionError("PDF file contains 0 pages.")

        metadata = {
            "title": doc.metadata.get("title", ""),
            "author": doc.metadata.get("author", ""),
            "subject": doc.metadata.get("subject", ""),
            "creator": doc.metadata.get("creator", ""),
            "page_count": page_count,
            "format": doc.metadata.get("format", "PDF"),
        }

        pages_data: List[Dict[str, Any]] = []
        total_text_length = 0

        for page_idx in range(page_count):
            page_num = page_idx + 1  # 1-indexed
            try:
                page = doc[page_idx]
                text = page.get_text("text").strip()
                total_text_length += len(text)

                pages_data.append({
                    "page_number": page_num,
                    "text": text,
                    "char_count": len(text),
                    "word_count": len(text.split()) if text else 0,
                    "is_empty": len(text) == 0
                })
            except Exception as e:
                pages_data.append({
                    "page_number": page_num,
                    "text": "",
                    "char_count": 0,
                    "word_count": 0,
                    "is_empty": True,
                    "error": str(e)
                })

        doc.close()

        # Check for scanned or image-only PDF
        # If total characters extracted across all pages is fewer than 40 for a document
        is_scanned = total_text_length < 40
        if is_scanned:
            message = "Document appears to be scanned or image-based with no extractable text layer. OCR is required."
        else:
            message = "Extraction successful"

        return {
            "file_path": file_path,
            "metadata": metadata,
            "page_count": page_count,
            "total_char_count": total_text_length,
            "is_scanned": is_scanned,
            "status_message": message,
            "pages": pages_data
        }
