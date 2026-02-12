import { Client } from '@notionhq/client';
import { config } from '../config';
import { ContentDraft, ContentIdea, Transcript, ContentFormat } from '../types';

export class NotionService {
  private client: Client;

  constructor() {
    this.client = new Client({ auth: config.notion.apiKey });
  }

  /**
   * Ensure the Content DB has the 'Source Transcripts' property.
   * Runs on startup — safe to call repeatedly (no-op if already exists).
   */
  async ensureContentDbSchema(): Promise<void> {
    try {
      const db = await this.client.databases.retrieve({
        database_id: config.notion.contentDbId,
      });
      const props = (db as any).properties || {};
      if (!props['Source Transcripts']) {
        console.log('[notion] Adding "Source Transcripts" property to Content DB...');
        await this.client.databases.update({
          database_id: config.notion.contentDbId,
          properties: {
            'Source Transcripts': { rich_text: {} },
          },
        });
        console.log('[notion] Added "Source Transcripts" property');
      }
    } catch (error) {
      console.error('[notion] Warning: Could not ensure Content DB schema:', error);
    }
  }

  // --- Transcript Storage ---

  async saveTranscript(transcript: Transcript): Promise<string> {
    const response = await this.client.pages.create({
      parent: { database_id: config.notion.transcriptsDbId },
      properties: {
        Title: {
          title: [{ text: { content: transcript.title } }],
        },
        'Meeting ID': {
          rich_text: [{ text: { content: transcript.meetingId } }],
        },
        Date: {
          date: { start: transcript.date },
        },
        Participants: {
          rich_text: [{ text: { content: transcript.participants.join(', ') } }],
        },
        Source: {
          select: { name: transcript.source },
        },
        'Transcript ID': {
          rich_text: [{ text: { content: transcript.id } }],
        },
      },
      children: this.textToBlocks(transcript.content),
    });

    return response.id;
  }

  /**
   * Load transcript metadata from Notion (paginated, all pages).
   * Content is loaded lazily via loadTranscriptContent() when needed for mining.
   * This keeps startup fast even with hundreds of transcripts.
   */
  async loadTranscripts(): Promise<Transcript[]> {
    const transcripts: Transcript[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.databases.query({
        database_id: config.notion.transcriptsDbId,
        sorts: [{ property: 'Date', direction: 'descending' }],
        page_size: 100,
        start_cursor: cursor,
      });

      for (const page of response.results) {
        if (!('properties' in page)) continue;

        const props = page.properties as Record<string, any>;

        transcripts.push({
          id: this.extractRichText(props['Transcript ID']),
          meetingId: this.extractRichText(props['Meeting ID']),
          title: this.extractTitle(props['Title']),
          date: props['Date']?.date?.start || '',
          participants: this.extractRichText(props['Participants']).split(', ').filter(Boolean),
          content: '', // Loaded on demand via loadTranscriptContent()
          source: props['Source']?.select?.name || 'tldv',
          notionPageId: page.id,
        });
      }

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return transcripts;
  }

  /**
   * Load full transcript content from a Notion page body.
   * Called on demand when mining needs the actual text.
   */
  async loadTranscriptContent(notionPageId: string): Promise<string> {
    return this.loadPageContent(notionPageId);
  }

  /**
   * Load all text content from a Notion page's body blocks.
   */
  private async loadPageContent(pageId: string): Promise<string> {
    const blocks: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const block of response.results) {
        if (!('type' in block)) continue;
        const b = block as any;

        // Extract text from common block types
        const richText =
          b[b.type]?.rich_text ||
          b[b.type]?.text;

        if (Array.isArray(richText)) {
          const text = richText.map((t: any) => t.plain_text || '').join('');
          if (text) blocks.push(text);
        }
      }

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return blocks.join('\n');
  }

  // --- Content Ideas & Drafts ---

  async saveContentIdea(idea: ContentIdea): Promise<string> {
    const response = await this.client.pages.create({
      parent: { database_id: config.notion.contentDbId },
      properties: {
        Title: {
          title: [{ text: { content: idea.hook } }],
        },
        Theme: {
          rich_text: [{ text: { content: idea.theme } }],
        },
        Format: {
          select: { name: this.formatLabel(idea.suggestedFormat) },
        },
        Status: {
          select: { name: idea.status },
        },
        'Created At': {
          date: { start: idea.createdAt },
        },
        'Source Transcripts': {
          rich_text: [{ text: { content: idea.sourceTranscriptIds.join(',') } }],
        },
      },
      children: [
        {
          object: 'block' as const,
          type: 'heading_2' as const,
          heading_2: {
            rich_text: [{ type: 'text' as const, text: { content: 'Raw Quotes' } }],
          },
        },
        ...idea.rawQuotes.map(quote => ({
          object: 'block' as const,
          type: 'quote' as const,
          quote: {
            rich_text: [{ type: 'text' as const, text: { content: quote } }],
          },
        })),
      ],
    });

    return response.id;
  }

  async saveContentDraft(draft: ContentDraft): Promise<string> {
    const response = await this.client.pages.create({
      parent: { database_id: config.notion.contentDbId },
      properties: {
        Title: {
          title: [{ text: { content: `[DRAFT] ${draft.title}` } }],
        },
        Format: {
          select: { name: this.formatLabel(draft.format) },
        },
        Status: {
          select: { name: draft.status },
        },
        'Created At': {
          date: { start: draft.createdAt },
        },
      },
      children: this.textToBlocks(draft.body),
    });

    return response.id;
  }

  /**
   * Load all content ideas from the Content Pipeline DB.
   * Used on startup to restore ideas so they persist across restarts.
   */
  async loadContentIdeas(): Promise<ContentIdea[]> {
    const ideas: ContentIdea[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.databases.query({
        database_id: config.notion.contentDbId,
        sorts: [{ property: 'Created At', direction: 'descending' }],
        page_size: 100,
        start_cursor: cursor,
      });

      for (const page of response.results) {
        if (!('properties' in page)) continue;

        const props = page.properties as Record<string, any>;
        const title = this.extractTitle(props['Title']);

        // Skip drafts — they start with "[DRAFT]"
        if (title.startsWith('[DRAFT]')) continue;

        const formatSelect = props['Format']?.select?.name || '';
        const status = props['Status']?.select?.name || 'extracted';
        const theme = this.extractRichText(props['Theme']);
        const createdAt = props['Created At']?.date?.start || new Date().toISOString();

        // Load raw quotes from the page body
        const rawQuotes = await this.loadQuoteBlocks(page.id);

        ideas.push({
          id: page.id, // Use Notion page ID as the idea ID
          sourceTranscriptIds: this.extractRichText(props['Source Transcripts']).split(',').filter(Boolean),
          theme,
          hook: title,
          rawQuotes,
          suggestedFormat: this.parseFormat(formatSelect),
          status: status as ContentIdea['status'],
          createdAt,
          notionPageId: page.id,
        });
      }

      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return ideas;
  }

  /**
   * Load quote blocks from a content idea page body.
   */
  private async loadQuoteBlocks(pageId: string): Promise<string[]> {
    const quotes: string[] = [];

    try {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        page_size: 100,
      });

      for (const block of response.results) {
        if (!('type' in block)) continue;
        const b = block as any;

        if (b.type === 'quote' && Array.isArray(b.quote?.rich_text)) {
          const text = b.quote.rich_text.map((t: any) => t.plain_text || '').join('');
          if (text) quotes.push(text);
        }
      }
    } catch (error) {
      console.error(`[notion] Failed to load quotes for page ${pageId}:`, error);
    }

    return quotes;
  }

  /**
   * Parse a Notion format label back to ContentFormat.
   */
  private parseFormat(label: string): ContentFormat {
    const reverseLabels: Record<string, ContentFormat> = {
      'LinkedIn Post': 'linkedin_post',
      'YouTube Script': 'youtube_script',
      'Newsletter': 'newsletter',
      'X Thread': 'x_thread',
    };
    return reverseLabels[label] || 'linkedin_post';
  }

  async updatePageStatus(pageId: string, status: string): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        Status: {
          select: { name: status },
        },
      },
    });
  }

  // --- Helpers ---

  private formatLabel(format: ContentFormat): string {
    const labels: Record<ContentFormat, string> = {
      linkedin_post: 'LinkedIn Post',
      youtube_script: 'YouTube Script',
      newsletter: 'Newsletter',
      x_thread: 'X Thread',
    };
    return labels[format] || format;
  }

  private extractTitle(prop: any): string {
    if (prop?.title?.[0]?.plain_text) return prop.title[0].plain_text;
    return '';
  }

  private extractRichText(prop: any): string {
    if (prop?.rich_text?.[0]?.plain_text) return prop.rich_text[0].plain_text;
    return '';
  }

  /**
   * Splits long text into Notion paragraph blocks (max 2000 chars per block)
   */
  private textToBlocks(text: string): Array<any> {
    const maxLen = 2000;
    const blocks: Array<any> = [];
    const paragraphs = text.split('\n\n');

    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) continue;

      // Split long paragraphs into chunks
      for (let i = 0; i < paragraph.length; i += maxLen) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: { content: paragraph.slice(i, i + maxLen) },
              },
            ],
          },
        });
      }
    }

    return blocks;
  }
}
