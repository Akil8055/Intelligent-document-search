import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { query } from '../db/index.js';
import { documentService } from './documentService.js';
import { config } from '../config.js';

export interface IngestionJobData {
  documentId: string;
  ingestionJobId: string;
}

export interface QueueStatus {
  provider: 'bullmq-redis' | 'in-memory-worker';
  is_connected: boolean;
  active_jobs: number;
  queued_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
}

export class QueueService {
  private redisClient: Redis | null = null;
  private bullQueue: Queue<IngestionJobData> | null = null;
  private bullWorker: Worker<IngestionJobData> | null = null;

  // Local fallback queue state
  private isBullMQ: boolean = false;
  private localQueue: IngestionJobData[] = [];
  private activeCount: number = 0;
  private maxConcurrency: number = 2;
  private isShuttingDown: boolean = false;
  private completedCount: number = 0;
  private failedCount: number = 0;

  async initialize(redisUrl: string = config.redisUrl): Promise<void> {
    try {
      const testRedis = new Redis(redisUrl, {
        connectTimeout: 1500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Do not reconnect if offline
        lazyConnect: true,
      });

      testRedis.on('error', () => {}); // Prevent unhandled error event if offline

      await testRedis.connect();
      console.log('Connected to Redis server. Initializing BullMQ queue...');
      this.redisClient = testRedis;

      this.bullQueue = new Queue<IngestionJobData>('document-ingestion', {
        connection: this.redisClient as any,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      });

      this.bullWorker = new Worker<IngestionJobData>(
        'document-ingestion',
        async (job: Job<IngestionJobData>) => {
          await this.executeIngestion(job.data.documentId, job.attemptsMade + 1, job.data.ingestionJobId);
        },
        {
          connection: this.redisClient as any,
          concurrency: this.maxConcurrency,
        }
      );

      this.bullWorker.on('completed', () => {
        this.completedCount++;
      });

      this.bullWorker.on('failed', (job, err) => {
        this.failedCount++;
        console.error(`BullMQ job failed for document ${job?.data?.documentId}:`, err.message);
      });

      this.isBullMQ = true;
      console.log('BullMQ background worker initialized successfully.');
    } catch (err: any) {
      console.log(
        'Redis server not reachable on localhost:6379. Using local concurrency-bounded background queue provider.'
      );
      this.isBullMQ = false;
    }
  }

  async enqueueIngestion(documentId: string): Promise<{ jobId: string; status: string; provider: string }> {
    // Record job in database ingestion_jobs table
    const jobRes = await query<{ id: string }>(
      `INSERT INTO ingestion_jobs (document_id, status, attempts, started_at)
       VALUES ($1, 'queued', 0, NOW())
       RETURNING id;`,
      [documentId]
    );
    const dbJobId = jobRes.rows[0].id;

    if (this.isBullMQ && this.bullQueue) {
      const bullJob = await this.bullQueue.add(
        'process-pdf',
        { documentId, ingestionJobId: dbJobId },
        { jobId: dbJobId }
      );
      return { jobId: bullJob.id || dbJobId, status: 'queued', provider: 'bullmq-redis' };
    }

    // Local asynchronous worker queue
    this.localQueue.push({ documentId, ingestionJobId: dbJobId });
    setTimeout(() => this.processNextLocalJob(), 10);

    return { jobId: dbJobId, status: 'queued', provider: 'in-memory-worker' };
  }

  private async processNextLocalJob(): Promise<void> {
    if (this.isShuttingDown || this.activeCount >= this.maxConcurrency || this.localQueue.length === 0) {
      return;
    }

    const job = this.localQueue.shift();
    if (!job) return;

    this.activeCount++;

    (async () => {
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success) {
        attempts++;
        try {
          await this.executeIngestion(job.documentId, attempts, job.ingestionJobId);
          success = true;
          this.completedCount++;
        } catch (err: any) {
          console.warn(`Attempt ${attempts} failed for doc ${job.documentId}: ${err.message}`);
          if (attempts < maxAttempts) {
            // Exponential backoff: 500ms, 1000ms
            await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempts - 1)));
          } else {
            this.failedCount++;
          }
        }
      }

      this.activeCount--;
      this.processNextLocalJob();
    })();
  }

  private async executeIngestion(documentId: string, attempt: number, ingestionJobId: string): Promise<void> {
    await query(
      `UPDATE ingestion_jobs 
       SET status = 'processing', attempts = $1, updated_at = NOW() 
       WHERE id = $2 AND document_id = $3;`,
      [attempt, ingestionJobId, documentId]
    );

    try {
      await documentService.processDocument(documentId);

      await query(
        `UPDATE ingestion_jobs 
         SET status = 'completed', completed_at = NOW(), error_details = NULL, updated_at = NOW() 
         WHERE id = $1;`,
        [ingestionJobId]
      );
    } catch (err: any) {
      await query(
        `UPDATE ingestion_jobs 
         SET status = 'failed', error_details = $1, updated_at = NOW() 
         WHERE id = $2;`,
        [err.message || 'Processing error', ingestionJobId]
      );
      throw err;
    }
  }

  async getStatus(): Promise<QueueStatus> {
    return {
      provider: this.isBullMQ ? 'bullmq-redis' : 'in-memory-worker',
      is_connected: this.isBullMQ,
      active_jobs: this.activeCount,
      queued_jobs: this.localQueue.length,
      completed_jobs: this.completedCount,
      failed_jobs: this.failedCount,
    };
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.bullWorker) {
      await this.bullWorker.close();
    }
    if (this.bullQueue) {
      await this.bullQueue.close();
    }
    if (this.redisClient) {
      this.redisClient.disconnect();
    }
  }
}

export const queueService = new QueueService();
