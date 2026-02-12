import { Transcript } from '../types';
import { NotionService } from './notion';

/**
 * In-memory transcript store with Notion persistence.
 * Transcripts are kept in memory for fast access during content mining,
 * and persisted to Notion for long-term storage.
 */
export class TranscriptStore {
  private transcripts: Map<string, Transcript> = new Map();
  private notion: NotionService;

  constructor(notion: NotionService) {
    this.notion = notion;
  }

  async save(transcript: Transcript): Promise<void> {
    // Skip if already exists (loaded from Notion or saved previously)
    if (this.transcripts.has(transcript.id)) {
      return;
    }

    transcript.processedAt = new Date().toISOString();
    this.transcripts.set(transcript.id, transcript);

    // Persist to Notion
    try {
      const notionPageId = await this.notion.saveTranscript(transcript);
      transcript.notionPageId = notionPageId;
      console.log(`[store] New transcript saved: "${transcript.title}"`);
    } catch (error) {
      console.error(`[store] Failed to persist transcript to Notion: ${transcript.id}`, error);
    }
  }

  has(id: string): boolean {
    return this.transcripts.has(id);
  }

  get(id: string): Transcript | undefined {
    return this.transcripts.get(id);
  }

  getRecent(days: number = 7): Transcript[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return Array.from(this.transcripts.values())
      .filter(t => new Date(t.date) >= cutoff)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  getAll(): Transcript[] {
    return Array.from(this.transcripts.values())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  /**
   * Load transcripts from Notion on startup
   */
  async loadFromNotion(): Promise<void> {
    try {
      const transcripts = await this.notion.loadTranscripts();
      for (const t of transcripts) {
        this.transcripts.set(t.id, t);
      }
      console.log(`[store] Loaded ${transcripts.length} transcripts from Notion`);
    } catch (error) {
      console.error('[store] Failed to load transcripts from Notion:', error);
    }
  }
}
