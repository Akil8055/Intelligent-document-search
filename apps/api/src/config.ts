import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(configDirectory, '../../..');

// Load the project-level local configuration regardless of the process working directory.
dotenv.config({ path: path.join(projectRoot, '.env') });

const jwtSecret = process.env.JWT_SECRET?.trim();
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set in the project .env file and contain at least 32 characters.');
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set in the project .env file.');
}

const uploadPath = process.env.UPLOAD_DIR?.trim() || 'data/uploads';

export const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl,
  uploadDir: path.resolve(projectRoot, uploadPath),
  maxFileSizeMb: Number.parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10),
  aiServiceUrl: (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
};

