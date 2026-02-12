import { ContentIdea, Transcript } from '../types';
import { AIBrain } from './ai-brain';
import { NotionService } from './notion';

/**
 * ContentMiner processes transcripts and extracts content ideas.
 * It maintains a queue of transcripts to process and stores extracted ideas.
 */
export class ContentMiner {
  private brain: AIBrain;
  private notion: NotionService;
  private ideas: Map<string, ContentIdea> = new Map();
  private pendingTranscripts: Transcript[] = [];
  private processing = false;
  private minedTranscriptIds: Set<string> = new Set();
  private knownHooks: Set<string> = new Set(); // Dedup: prevent saving duplicate ideas

  constructor(brain: AIBrain, notion: NotionService) {
    this.brain = brain;
    this.notion = notion;
  }

  /**
   * Load existing ideas from Notion on startup.
   * Populates the ideas Map so `ideas` command works immediately,
   * and seeds minedTranscriptIds from sourceTranscriptIds so transcripts
   * aren't re-mined after a restart.
   */
  async loadFromNotion(allTranscriptIds?: string[]): Promise<void> {
    try {
      const ideas = await this.notion.loadContentIdeas();
      let hasOrphanedIdeas = false;

      for (const idea of ideas) {
        this.ideas.set(idea.id, idea);

        // Track hook for dedup
        this.knownHooks.add(this.normalizeHook(idea.hook));

        // Mark source transcripts as already mined
        if (idea.sourceTranscriptIds.length > 0) {
          for (const tid of idea.sourceTranscriptIds) {
            this.minedTranscriptIds.add(tid);
          }
        } else {
          hasOrphanedIdeas = true;
        }
      }

      // If there are ideas without sourceTranscriptIds (created before we tracked them),
      // mark ALL provided transcript IDs as mined to prevent re-mining
      if (hasOrphanedIdeas && allTranscriptIds) {
        for (const tid of allTranscriptIds) {
          this.minedTranscriptIds.add(tid);
        }
        console.log(`[miner] Marked all ${allTranscriptIds.length} transcripts as mined (legacy ideas without source tracking)`);
      }

      console.log(`[miner] Loaded ${ideas.length} ideas from Notion (${this.minedTranscriptIds.size} transcripts marked as mined, ${this.knownHooks.size} unique hooks)`);
    } catch (error) {
      console.error('[miner] Failed to load ideas from Notion:', error);
    }
  }

  /**
   * Normalize a hook string for dedup comparison.
   * Lowercases, strips punctuation, and collapses whitespace.
   */
  private normalizeHook(hook: string): string {
    return hook.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Check if a similar idea already exists (by hook text).
   */
  private isDuplicate(hook: string): boolean {
    return this.knownHooks.has(this.normalizeHook(hook));
  }

  /**
   * Queue a transcript for content mining.
   * Processing happens asynchronously.
   */
  async queueTranscript(transcript: Transcript): Promise<void> {
    this.pendingTranscripts.push(transcript);
    console.log(
      `[miner] Queued transcript: "${transcript.title}" (${this.pendingTranscripts.length} pending)`
    );

    // Process if not already running
    if (!this.processing) {
      await this.processQueue();
    }
  }

  /**
   * Process all pending transcripts and extract content ideas.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.pendingTranscripts.length === 0) return;

    this.processing = true;

    try {
      // Batch process pending transcripts
      const batch = this.pendingTranscripts.splice(0, 5); // Process up to 5 at a time
      console.log(`[miner] Processing batch of ${batch.length} transcripts`);

      const ideas = await this.brain.mineContentIdeas(batch);

      for (const idea of ideas) {
        this.ideas.set(idea.id, idea);

        // Save to Notion
        try {
          const notionPageId = await this.notion.saveContentIdea(idea);
          idea.notionPageId = notionPageId;
          console.log(`[miner] Saved idea to Notion: "${idea.hook}" (${notionPageId})`);
        } catch (error) {
          console.error(`[miner] Failed to save idea to Notion:`, error);
        }
      }

      console.log(`[miner] Extracted ${ideas.length} ideas from ${batch.length} transcripts`);
    } catch (error) {
      console.error('[miner] Error processing queue:', error);
    } finally {
      this.processing = false;

      // Process remaining if any
      if (this.pendingTranscripts.length > 0) {
        await this.processQueue();
      }
    }
  }

  /**
   * Mine content ideas from a set of transcripts on demand.
   * Used by the scheduler for the scheduled mining runs.
   * Processes in batches of 10 to avoid overwhelming the AI with too much context.
   */
  async mineFromTranscripts(transcripts: Transcript[]): Promise<ContentIdea[]> {
    if (transcripts.length === 0) return [];

    // Skip transcripts we've already mined this session
    const unmined = transcripts.filter(t => !this.minedTranscriptIds.has(t.id));
    if (unmined.length === 0) {
      console.log(`[miner] All ${transcripts.length} transcripts already mined this session — skipping`);
      return [];
    }
    console.log(`[miner] ${unmined.length} new transcripts to mine (${transcripts.length - unmined.length} already mined)`);

    // Filter to transcripts that actually have content
    // Load content from Notion for transcripts that were loaded without it
    const withContent: Transcript[] = [];
    for (const t of unmined) {
      if (t.content && t.content.length > 50) {
        withContent.push(t);
      } else if (t.notionPageId) {
        try {
          console.log(`[miner] Loading content for "${t.title}" from Notion...`);
          t.content = await this.notion.loadTranscriptContent(t.notionPageId);
          if (t.content && t.content.length > 50) {
            withContent.push(t);
          } else {
            console.log(`[miner] Skipping "${t.title}" - no meaningful content (${t.content?.length || 0} chars)`);
          }
        } catch (error) {
          console.error(`[miner] Failed to load content for "${t.title}":`, error);
        }
      } else {
        console.log(`[miner] Skipping "${t.title}" - no content and no Notion page`);
      }
      // Mark as mined regardless so we don't retry empties
      this.minedTranscriptIds.add(t.id);
    }

    console.log(`[miner] ${withContent.length}/${unmined.length} transcripts have content to mine`);

    if (withContent.length === 0) return [];

    // Truncate each transcript to first 4000 chars to avoid massive context
    for (const t of withContent) {
      if (t.content && t.content.length > 4000) {
        t.content = t.content.slice(0, 4000) + '\n\n[... transcript truncated for processing]';
      }
    }

    const allIdeas: ContentIdea[] = [];
    const batchSize = 10;

    for (let i = 0; i < withContent.length; i += batchSize) {
      const batch = withContent.slice(i, i + batchSize);
      console.log(`[miner] Mining batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(withContent.length / batchSize)}: ${batch.map(t => t.title).join(', ')}`);

      try {
        const ideas = await this.brain.mineContentIdeas(batch);
        console.log(`[miner] Batch returned ${ideas.length} ideas`);

        for (const idea of ideas) {
          // Dedup: skip if we already have a very similar idea
          if (this.isDuplicate(idea.hook)) {
            console.log(`[miner] Skipping duplicate idea: "${idea.hook.slice(0, 60)}..."`);
            continue;
          }

          this.ideas.set(idea.id, idea);
          this.knownHooks.add(this.normalizeHook(idea.hook));

          try {
            const notionPageId = await this.notion.saveContentIdea(idea);
            idea.notionPageId = notionPageId;
          } catch (error) {
            console.error(`[miner] Failed to save idea to Notion:`, error);
          }

          allIdeas.push(idea);
        }
      } catch (error) {
        console.error(`[miner] Error mining batch:`, error);
      }
    }

    return allIdeas;
  }

  /**
   * Get ideas that haven't been turned into drafts yet.
   */
  getUnprocessedIdeas(): ContentIdea[] {
    return Array.from(this.ideas.values()).filter(
      idea => idea.status === 'extracted'
    );
  }

  /**
   * Get a specific idea by ID.
   */
  getIdea(id: string): ContentIdea | undefined {
    return this.ideas.get(id);
  }

  /**
   * Update an idea's status.
   */
  async updateIdeaStatus(id: string, status: ContentIdea['status']): Promise<void> {
    const idea = this.ideas.get(id);
    if (!idea) return;

    idea.status = status;

    if (idea.notionPageId) {
      try {
        await this.notion.updatePageStatus(idea.notionPageId, status);
      } catch (error) {
        console.error(`[miner] Failed to update idea status in Notion:`, error);
      }
    }
  }

  /**
   * Get all ideas.
   */
  getAllIdeas(): ContentIdea[] {
    return Array.from(this.ideas.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
