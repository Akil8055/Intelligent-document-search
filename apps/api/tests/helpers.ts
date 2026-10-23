import { query } from '../src/db/index.js';
import { documentService } from '../src/services/documentService.js';

export async function deleteTestUserData(userId: string): Promise<void> {
  const documents = await query<{ id: string }>('SELECT id FROM documents WHERE user_id = $1', [userId]);
  for (const document of documents.rows) {
    await documentService.deleteDocument(document.id, userId);
  }
  await query('DELETE FROM users WHERE id = $1', [userId]);
}
