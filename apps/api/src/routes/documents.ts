import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate } from '../middleware/auth.js';
import { documentService } from '../services/documentService.js';
import { config } from '../config.js';

export const documentsRouter = Router();

// Ensure upload directory exists
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `doc-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.maxFileSizeMb * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const isPdfMime = file.mimetype === 'application/pdf';
    const isPdfExt = path.extname(file.originalname).toLowerCase() === '.pdf';
    if (isPdfMime || isPdfExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF documents are supported.'));
    }
  },
});

// All document routes require authentication
documentsRouter.use(authenticate);

import { queueService } from '../services/queueService.js';

// 1. Upload & ingest document
documentsRouter.post('/documents', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No PDF file provided. Use form field "file".' });
    return;
  }

  const userId = req.user!.id;
  const isSync = req.query.sync === 'true';

  try {
    const document = await documentService.createDocument({
      userId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype || 'application/pdf',
      fileSize: req.file.size,
    });

    if (isSync) {
      // Synchronous processing on explicit request
      try {
        const processed = await documentService.processDocument(document.id);
        res.status(201).json({
          message: 'Document uploaded and indexed successfully (sync)',
          document: processed,
        });
      } catch (processErr: any) {
        const failedDoc = await documentService.getDocumentById(document.id, userId);
        res.status(422).json({
          message: 'Document uploaded but processing failed',
          error: processErr.message,
          document: failedDoc,
        });
      }
      return;
    }

    // Default: Asynchronous background ingestion via QueueService
    const jobInfo = await queueService.enqueueIngestion(document.id);

    res.status(202).json({
      message: 'Document uploaded and queued for background processing',
      job_id: jobInfo.jobId,
      queue_provider: jobInfo.provider,
      document,
    });
  } catch (err: any) {
    console.error('Document upload error:', err);
    res.status(500).json({ error: 'Failed to upload and store document', details: err.message });
  }
});

// 2. List user's documents
documentsRouter.get('/documents', async (req, res) => {
  try {
    const docs = await documentService.listDocuments(req.user!.id);
    res.json({ count: docs.length, documents: docs });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve documents', details: err.message });
  }
});

// 3. Get document details
documentsRouter.get('/documents/:id', async (req, res) => {
  try {
    const doc = await documentService.getDocumentById(req.params.id, req.user!.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found or unauthorized' });
      return;
    }
    res.json({ document: doc });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve document', details: err.message });
  }
});

// 4. Get document status
documentsRouter.get('/documents/:id/status', async (req, res) => {
  try {
    const doc = await documentService.getDocumentById(req.params.id, req.user!.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found or unauthorized' });
      return;
    }
    res.json({
      id: doc.id,
      status: doc.status,
      page_count: doc.page_count,
      error_message: doc.error_message,
      updated_at: doc.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve document status', details: err.message });
  }
});

// 5. Delete document
documentsRouter.delete('/documents/:id', async (req, res) => {
  try {
    const success = await documentService.deleteDocument(req.params.id, req.user!.id);
    if (!success) {
      res.status(404).json({ error: 'Document not found or unauthorized' });
      return;
    }
    res.json({ message: 'Document and indexed vectors deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete document', details: err.message });
  }
});

// 6. Retry failed document ingestion
documentsRouter.post('/documents/:id/retry', async (req, res) => {
  try {
    const doc = await documentService.getDocumentById(req.params.id, req.user!.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found or unauthorized' });
      return;
    }

    const jobInfo = await queueService.enqueueIngestion(doc.id);
    res.status(202).json({
      message: 'Document retry queued for background processing',
      job_id: jobInfo.jobId,
      queue_provider: jobInfo.provider,
      document: { ...doc, status: 'queued', error_message: null },
    });
  } catch (err: any) {
    res.status(422).json({
      error: 'Document retry processing failed',
      details: err.message,
    });
  }
});

// 7. Queue status & health check
documentsRouter.get('/queue/status', async (req, res) => {
  const status = await queueService.getStatus();
  res.json(status);
});
