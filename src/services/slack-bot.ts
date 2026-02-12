import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, LogLevel } from '@slack/web-api';
import { config } from '../config';
import { AIBrain } from './ai-brain';
import { ContentMiner } from './content-miner';
import { TranscriptStore } from './transcript-store';
import { NotionService } from './notion';
import {
  ContentDraft,
  ContentFormat,
  ContentIdea,
  InterviewMessage,
  InterviewSession,
} from '../types';
import fs from 'fs';
import path from 'path';

/**
 * Load the voice profile from a file or environment variable.
 *
 * Priority:
 *   1. VOICE_PROFILE_PATH env var → reads that file
 *   2. ./voice-profile.md in the project root
 *   3. A sensible default prompt
 *
 * To customise: create a voice-profile.md file describing how you write,
 * what you never do, and what structural patterns you use.
 */
function loadVoiceProfile(): string {
  // 1. Explicit path from env
  const envPath = process.env.VOICE_PROFILE_PATH;
  if (envPath) {
    try {
      return fs.readFileSync(path.resolve(envPath), 'utf-8');
    } catch (err) {
      console.warn(`[voice] Could not read VOICE_PROFILE_PATH="${envPath}":`, err);
    }
  }

  // 2. Default file in project root
  const defaultPath = path.resolve(__dirname, '../../voice-profile.md');
  try {
    if (fs.existsSync(defaultPath)) {
      return fs.readFileSync(defaultPath, 'utf-8');
    }
  } catch {
    // Fall through to default
  }

  // 3. Generic default
  return `## Voice & Tone
- Direct and conversational — writes like they talk, not like a corporate blog
- Uses real stories from their own experience
- Short paragraphs — 1-2 sentences max per paragraph in LinkedIn posts
- Opens with a bold statement or a story, never with generic filler
- Ends with a takeaway or direct question, not a generic CTA

## What to NEVER do
- No "In today's fast-paced world" or "Let me be honest" or "Here's the thing"
- No corporate buzzwords: "synergy", "paradigm shift", "thought leadership", "value-add"
- No superlatives: "best in class", "industry-leading", "cutting-edge"
- No sycophantic openers: "Great question!", "Love this!"
- No hashtag spam
- No rhetorical questions as openers ("Tired of...?", "What if you could...?")
- No AI slop patterns: "Let's dive in", "It's important to note", "In conclusion"

## Content Principles
- Relevance over cleverness — a well-researched observation beats a witty one-liner
- One idea per post — don't stack three value propositions into one piece
- Earn the next step — the goal is engagement, not a lecture
- Short is strong — every word must earn its place
- Specificity wins — real names, real numbers, real situations

## Structural Patterns
- Hook > Story > Insight > Takeaway (LinkedIn posts)
- Bold opening line that stops the scroll
- Line breaks between every 1-2 sentences for mobile readability
- Ends with a question that invites genuine discussion, not just likes`;
}

const VOICE_PROFILE = loadVoiceProfile();

export class SlackBot {
  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private brain: AIBrain;
  private miner: ContentMiner;
  private transcriptStore: TranscriptStore;
  private notion: NotionService;
  private activeSessions: Map<string, InterviewSession> = new Map();
  private pendingDrafts: Map<string, ContentDraft> = new Map();
  private lastShownIdeas: ContentIdea[] = []; // Track ideas shown to user for number selection
  private pendingRework: { draftId: string; ideaId: string } | null = null; // Awaiting rework feedback
  private botUserId: string | null = null; // Resolved on start to filter self-messages

  constructor(
    brain: AIBrain,
    miner: ContentMiner,
    transcriptStore: TranscriptStore,
    notion: NotionService
  ) {
    this.brain = brain;
    this.miner = miner;
    this.transcriptStore = transcriptStore;
    this.notion = notion;

    this.socketClient = new SocketModeClient({
      appToken: config.slack.appToken,
      logLevel: LogLevel.INFO,
    });

    this.webClient = new WebClient(config.slack.botToken);

    this.registerHandlers();
  }

  async start(): Promise<void> {
    // Resolve bot user ID so we can filter self-messages
    try {
      const authResult = await this.webClient.auth.test();
      this.botUserId = authResult.user_id as string;
      console.log(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (error) {
      console.error('[slack] Failed to resolve bot user ID:', error);
    }

    await this.socketClient.start();
    console.log('[slack] Bot is running in socket mode');
  }

  // --- Public methods for scheduler ---

  /**
   * Send a content interview ping to the user.
   * Called by the scheduler on Mon/Wed/Fri.
   */
  async sendContentPing(idea: ContentIdea): Promise<void> {
    const context = this.buildContext();
    const opener = await this.brain.generateInterviewOpener(idea, context);

    const result = await this.webClient.chat.postMessage({
      channel: config.slack.userId,
      text: opener,
      metadata: {
        event_type: 'content_interview',
        event_payload: { ideaId: idea.id },
      },
    });

    if (result.ts) {
      const session: InterviewSession = {
        id: `session-${Date.now()}`,
        ideaId: idea.id,
        slackThreadTs: result.ts,
        messages: [
          {
            role: 'agent',
            content: opener,
            timestamp: new Date().toISOString(),
          },
        ],
        status: 'active',
        startedAt: new Date().toISOString(),
      };

      this.activeSessions.set(result.ts, session);
      await this.miner.updateIdeaStatus(idea.id, 'interviewing');

      console.log(`[slack] Started interview for idea: "${idea.hook}"`);
    }
  }

  /**
   * Send a notification about a new content draft.
   */
  async sendDraftNotification(draft: ContentDraft, idea: ContentIdea): Promise<void> {
    const formatLabel = {
      linkedin_post: 'LinkedIn Post',
      youtube_script: 'YouTube Script',
      newsletter: 'Newsletter',
      x_thread: 'X Thread',
    }[draft.format];

    // Send the full draft as a readable message first
    const headerMsg = await this.webClient.chat.postMessage({
      channel: config.slack.userId,
      text: `\u{1F4DD} *${formatLabel} Draft Ready*\n\n*Theme:* ${idea.theme}\n*Hook:* ${idea.hook}`,
    });

    // Send the full draft body as a threaded reply so it's all visible
    const threadTs = headerMsg.ts;

    // Split long drafts into chunks if needed (Slack max is ~4000 chars per message)
    const maxLen = 3500;
    const body = draft.body;

    if (body.length <= maxLen) {
      await this.webClient.chat.postMessage({
        channel: config.slack.userId,
        thread_ts: threadTs,
        text: body,
      });
    } else {
      // Split on paragraph breaks
      const chunks: string[] = [];
      let current = '';
      for (const para of body.split('\n\n')) {
        if ((current + '\n\n' + para).length > maxLen && current.length > 0) {
          chunks.push(current.trim());
          current = para;
        } else {
          current = current ? current + '\n\n' + para : para;
        }
      }
      if (current.trim()) chunks.push(current.trim());

      for (const chunk of chunks) {
        await this.webClient.chat.postMessage({
          channel: config.slack.userId,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    }

    // Send action buttons as a separate message in the thread
    await this.webClient.chat.postMessage({
      channel: config.slack.userId,
      thread_ts: threadTs,
      text: 'What do you want to do with this draft?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '\u{1F446} *Read the full draft above.* What do you want to do?',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve & Publish' },
              style: 'primary',
              action_id: 'approve_draft',
              value: draft.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Rework' },
              action_id: 'rework_draft',
              value: draft.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Syndicate to X' },
              action_id: 'syndicate_x',
              value: draft.id,
            },
          ],
        },
      ],
    });

    this.pendingDrafts.set(draft.id, draft);
  }

  // --- Handler Registration ---

  private registerHandlers(): void {
    // Handle message events (DMs) - socket-mode emits inner event type directly
    this.socketClient.on('message', async (event) => {
      // Acknowledge immediately
      await event.ack();

      const msg = event.event;
      if (!msg) return;

      // Skip bot messages, edits, etc.
      if (msg.subtype) return;
      if (!msg.text) return;
      // Skip messages from the bot itself (multiple checks for safety)
      if (msg.bot_id) return;
      if (this.botUserId && msg.user === this.botUserId) return;

      // Only process DM messages from the configured user
      if (msg.user && msg.user !== config.slack.userId) return;

      console.log(`[slack] Received: "${msg.text}" (thread: ${msg.thread_ts || 'none'})`);

      // Strip Slack formatting (mentions, bold, italic, links) to get clean text for command matching
      const userMessage = msg.text
        .replace(/<@[A-Za-z0-9]+>/g, '')      // Remove @mentions like <@U12345>
        .replace(/<[^>]+\|([^>]+)>/g, '$1')  // <url|label> -> label
        .replace(/<[^>]+>/g, '')              // <url> -> empty
        .replace(/[*_~`]/g, '')              // Remove bold/italic/strike/code markers
        .trim();

      const threadTs = msg.thread_ts || msg.ts;
      const channel = msg.channel;

      const say = async (payload: string | { text: string; thread_ts?: string }) => {
        const opts = typeof payload === 'string' ? { text: payload } : payload;
        await this.webClient.chat.postMessage({
          channel,
          ...opts,
        });
      };

      try {
        // Check if this is a reply in an active interview thread (threaded reply)
        const session = this.activeSessions.get(threadTs || '');
        if (session && session.status === 'active') {
          await this.handleInterviewReply(session, userMessage, threadTs!, say);
          return;
        }

        // Also check: if there's any active interview and this is a non-threaded DM,
        // route it to the most recent active interview (so user doesn't need to reply in-thread)
        // BUT allow commands like "stop", "done", "ideas", "mine", "status", "help" to pass through
        if (!msg.thread_ts) {
          const lowerMsg = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          const isCommand = ['stop', 'done', 'ideas', 'mine', 'status', 'help', 'what do you have', 'show ideas', 'find content'].includes(lowerMsg);
          // Also treat bare numbers as commands (idea selection)
          const isNumber = /^\d{1,2}$/.test(lowerMsg);

          if (!isCommand && !isNumber) {
            const activeSession = this.getLatestActiveSession();
            if (activeSession) {
              await this.handleInterviewReply(
                activeSession,
                userMessage,
                activeSession.slackThreadTs,
                say
              );
              return;
            }
          }
        }

        // Check if we're awaiting rework feedback (but let commands pass through)
        if (this.pendingRework) {
          const cmd = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          const isCmd = ['stop', 'done', 'ideas', 'mine', 'status', 'help', 'cancel'].includes(cmd);
          if (cmd === 'cancel') {
            this.pendingRework = null;
            await say({ text: `Rework cancelled. What would you like to do?` });
            return;
          }
          if (!isCmd) {
            await this.handleReworkFeedback(userMessage, say);
            return;
          }
          // It's a command — clear rework state and fall through to handleCommand
          this.pendingRework = null;
        }

        // Handle direct commands
        await this.handleCommand(userMessage, say);
      } catch (error: any) {
        console.error(`[slack] Error handling message "${userMessage}":`, error?.message || error);
        try {
          await say({ text: `\u26A0\uFE0F Something went wrong processing that. Error: ${error?.message || 'Unknown error'}. Try again or type \`help\`.` });
        } catch (sayErr) {
          console.error('[slack] Failed to send error message:', sayErr);
        }
      }
    });

    // Handle interactive actions (button clicks)
    this.socketClient.on('interactive', async (event) => {
      await event.ack();

      try {
        const payload = event.body;
        console.log(`[slack] Interactive event received, type: ${payload?.type}`);
        if (!payload || payload.type !== 'block_actions') return;

        const actions = payload.actions || [];
        for (const action of actions) {
          console.log(`[slack] Button clicked: ${action.action_id}, value: ${action.value}`);
          if (action.action_id === 'approve_draft') {
            const value = action.value;
            if (!value) continue;

            const draft = this.pendingDrafts.get(value);
            if (draft) {
              draft.status = 'approved';
              if (draft.notionPageId) {
                await this.notion.updatePageStatus(draft.notionPageId, 'approved');
              }

              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `\u2705 Draft approved. Saved to Notion and ready for publishing.`,
              });
            } else {
              console.error(`[slack] Draft not found for value: ${value}. pendingDrafts keys: ${Array.from(this.pendingDrafts.keys()).join(', ')}`);
              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `\u26A0\uFE0F Couldn't find that draft — it may have expired. Run \`ideas\` and start again.`,
              });
            }
          } else if (action.action_id === 'rework_draft') {
            const draftId = action.value;
            const draft = draftId ? this.pendingDrafts.get(draftId) : undefined;
            if (draft) {
              this.pendingRework = { draftId: draft.id, ideaId: draft.ideaId };
              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `Got it. Reply with your feedback and I'll rework the draft.`,
              });
            } else {
              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `\u26A0\uFE0F Couldn't find that draft — it may have expired. Run \`ideas\` and start again.`,
              });
            }
          } else if (action.action_id === 'syndicate_x') {
            const value = action.value;
            if (!value) continue;

            const draft = this.pendingDrafts.get(value);
            if (draft && draft.format === 'linkedin_post') {
              const context = this.buildContext();
              const xThread = await this.brain.syndicateToXThread(draft.body, context);

              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `Here's the X thread version:\n\n${xThread}`,
              });
            } else {
              await this.webClient.chat.postMessage({
                channel: config.slack.userId,
                text: `Syndication works best with LinkedIn posts. Send me a LinkedIn draft first.`,
              });
            }
          }
        }
      } catch (error: any) {
        console.error('[slack] Error handling interactive event:', error?.message || error);
        try {
          await this.webClient.chat.postMessage({
            channel: config.slack.userId,
            text: `\u26A0\uFE0F Something went wrong with that action: ${error?.message || 'Unknown error'}`,
          });
        } catch (e) {
          console.error('[slack] Failed to send interactive error message:', e);
        }
      }
    });
  }

  // --- Interview Flow ---

  private async handleInterviewReply(
    session: InterviewSession,
    userMessage: string,
    threadTs: string,
    say: Function
  ): Promise<void> {
    // Record the user's message
    session.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    // Check if we have enough material
    const idea = this.miner.getIdea(session.ideaId);
    if (!idea) return;

    const hasEnough = await this.brain.hasEnoughMaterial(session.messages);

    if (hasEnough) {
      // Generate the draft
      await say({
        text: `I think I have enough. Let me draft something up...`,
        thread_ts: threadTs,
      });

      session.status = 'completed';
      session.completedAt = new Date().toISOString();

      const draft = await this.brain.generateDraft(
        idea,
        session.messages,
        idea.suggestedFormat,
        this.buildContext()
      );

      // Save to Notion
      try {
        draft.notionPageId = await this.notion.saveContentDraft(draft);
      } catch (error) {
        console.error('[slack] Failed to save draft to Notion:', error);
      }

      await this.miner.updateIdeaStatus(idea.id, 'draft_ready');

      // Send draft notification with action buttons
      await this.sendDraftNotification(draft, idea);

      // Also generate X thread automatically if it's a LinkedIn post
      if (idea.suggestedFormat === 'linkedin_post') {
        const context = this.buildContext();
        const xThread = await this.brain.syndicateToXThread(draft.body, context);

        await this.webClient.chat.postMessage({
          channel: config.slack.userId,
          text: `I also converted it to an X thread:\n\n${xThread}`,
        });
      }
    } else {
      // Ask a follow-up question
      const followUp = await this.brain.generateFollowUp(
        idea,
        session.messages,
        this.buildContext()
      );

      session.messages.push({
        role: 'agent',
        content: followUp,
        timestamp: new Date().toISOString(),
      });

      await say({
        text: followUp,
        thread_ts: threadTs,
      });
    }
  }

  // --- Rework Flow ---

  private async handleReworkFeedback(feedback: string, say: Function): Promise<void> {
    const rework = this.pendingRework;
    if (!rework) return;

    // Clear the pending state immediately so we don't loop
    this.pendingRework = null;

    const draft = this.pendingDrafts.get(rework.draftId);
    if (!draft) {
      await say({ text: `\u26A0\uFE0F Couldn't find the original draft. Try running \`ideas\` to start fresh.` });
      return;
    }

    const idea = this.miner.getIdea(rework.ideaId);

    await say({ text: `Reworking the draft with your feedback...` });

    try {
      const reworkedBody = await this.brain.reworkDraft(
        draft.body,
        feedback,
        draft.format,
        this.buildContext()
      );

      // Create a new draft version
      const newDraft: ContentDraft = {
        ...draft,
        id: `draft-${Date.now()}`,
        body: reworkedBody,
        version: draft.version + 1,
        status: 'draft',
        createdAt: new Date().toISOString(),
      };

      // Save to Notion
      try {
        newDraft.notionPageId = await this.notion.saveContentDraft(newDraft);
      } catch (error) {
        console.error('[slack] Failed to save reworked draft to Notion:', error);
      }

      // Send the reworked draft with action buttons
      await this.sendDraftNotification(newDraft, idea || {
        id: rework.ideaId,
        hook: draft.title,
        theme: '',
        sourceTranscriptIds: [],
        rawQuotes: [],
        suggestedFormat: draft.format,
        status: 'draft_ready',
        createdAt: draft.createdAt,
      } as ContentIdea);

      console.log(`[slack] Reworked draft v${newDraft.version} for "${draft.title}"`);
    } catch (error: any) {
      console.error('[slack] Error reworking draft:', error?.message || error);
      await say({ text: `\u26A0\uFE0F Failed to rework the draft: ${error?.message || 'Unknown error'}. Try again.` });
    }
  }

  // --- Command Handling ---

  private async handleCommand(text: string, say: Function): Promise<void> {
    // Aggressively normalize: lowercase, strip all non-alphanumeric (except spaces), collapse whitespace
    const command = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    if (command === 'stop' || command === 'done') {
      const active = this.getLatestActiveSession();
      if (active) {
        active.status = 'abandoned';
        await say({ text: `Interview stopped. Type \`ideas\` to see available ideas or \`mine\` to scan for new ones.` });
      } else {
        await say({ text: `No active interview to stop.` });
      }
    } else if (command === 'status' || command === 'what do you have') {
      await this.handleStatusCommand(say);
    } else if (command === 'ideas' || command === 'show ideas') {
      await this.handleIdeasCommand(say);
    } else if (command === 'mine' || command === 'find content') {
      await this.handleMineCommand(say);
    } else if (command.startsWith('draft ') || /^\d{1,2}$/.test(command)) {
      await this.handleDraftCommand(command, say);
    } else if (command === 'help') {
      await this.handleHelpCommand(say);
    } else {
      // Treat as a general conversation - might be context for content
      await say({
        text: `Noted. I'll factor that into future content ideas.\n\nNeed something specific? Try: \`status\`, \`ideas\`, \`mine\`, \`draft <idea-id>\`, or \`help\``,
      });
    }
  }

  private async handleStatusCommand(say: Function): Promise<void> {
    const ideas = this.miner.getAllIdeas();
    const transcripts = this.transcriptStore.getRecent(7);
    const activeInterviews = Array.from(this.activeSessions.values()).filter(
      s => s.status === 'active'
    );

    const statusParts = [
      `*Content Agent Status*`,
      ``,
      `Transcripts (last 7 days): ${transcripts.length}`,
      `Content ideas extracted: ${ideas.length}`,
      `Active interviews: ${activeInterviews.length}`,
      `Ideas ready for drafting: ${ideas.filter(i => i.status === 'extracted').length}`,
      `Drafts ready for review: ${ideas.filter(i => i.status === 'draft_ready').length}`,
      ``,
      `Posting goals: ${config.goals.linkedinPerWeek} LinkedIn/week, ${config.goals.newsletterPerWeek} newsletter/week`,
    ];

    await say({ text: statusParts.join('\n') });
  }

  private async handleIdeasCommand(say: Function): Promise<void> {
    const ideas = this.miner.getUnprocessedIdeas();

    if (ideas.length === 0) {
      await say({
        text: `No unprocessed ideas right now. Try \`mine\` to scan recent transcripts, or just keep having conversations - I'll pick up on things.`,
      });
      return;
    }

    const shown = ideas.slice(0, 10);
    this.lastShownIdeas = shown; // Store for number selection

    const ideaList = shown
      .map(
        (idea, i) =>
          `${i + 1}. *${idea.hook}*\n   Theme: ${idea.theme} | Format: ${idea.suggestedFormat}`
      )
      .join('\n\n');

    await say({
      text: `*Content Ideas Ready for Interview:*\n\n${ideaList}\n\nReply with the number to start an interview.`,
    });
  }

  private async handleMineCommand(say: Function): Promise<void> {
    const transcripts = this.transcriptStore.getRecent(90);

    if (transcripts.length === 0) {
      await say({
        text: `No recent transcripts to mine. Make sure tldv is sending transcripts to this agent.`,
      });
      return;
    }

    await say({
      text: `Mining ${transcripts.length} recent transcripts for content ideas...`,
    });

    const ideas = await this.miner.mineFromTranscripts(transcripts);

    if (ideas.length === 0) {
      await say({
        text: `Didn't find any strong content ideas this time. I'll keep watching.`,
      });
    } else {
      // Store ideas for number selection
      this.lastShownIdeas = ideas;

      const ideaList = ideas
        .map((idea, i) => `${i + 1}. *${idea.hook}*\n   -> ${idea.theme} (${idea.suggestedFormat})`)
        .join('\n\n');

      await say({
        text: `Found ${ideas.length} content ideas:\n\n${ideaList}\n\nWant me to start interviewing you on any of these?`,
      });
    }
  }

  private async handleDraftCommand(command: string, say: Function): Promise<void> {
    const input = command.replace('draft ', '').trim();

    // Support selecting by number from the last shown ideas list
    const num = parseInt(input, 10);
    let idea;
    if (!isNaN(num) && num >= 1 && num <= 99) {
      // Use lastShownIdeas (what the user actually saw), fall back to all ideas
      const list = this.lastShownIdeas.length > 0
        ? this.lastShownIdeas
        : this.miner.getAllIdeas();
      idea = list[num - 1];
      if (!idea) {
        await say({ text: `No idea at position ${num}. Try \`ideas\` or \`mine\` first.` });
        return;
      }
      console.log(`[slack] Draft by number ${num} -> idea: "${idea.id}" ("${idea.hook.slice(0, 40)}...")`);
    } else {
      // Look up by idea ID string
      console.log(`[slack] Draft command - looking up idea: "${input}"`);
      idea = this.miner.getIdea(input);
    }

    if (!idea) {
      // Try fuzzy match - find idea whose ID contains the input or vice versa
      const allIdeas = this.miner.getAllIdeas();
      const fuzzyMatch = allIdeas.find(i => i.id.includes(input) || input.includes(i.id));
      if (fuzzyMatch) {
        console.log(`[slack] Fuzzy matched to: "${fuzzyMatch.id}"`);
        await this.sendContentPing(fuzzyMatch);
        return;
      }

      await say({
        text: `Can't find idea with ID \`${input}\`. Try \`ideas\` to see available ones.`,
      });
      return;
    }

    // Start an interview for this idea
    await this.sendContentPing(idea);
  }

  private async handleHelpCommand(say: Function): Promise<void> {
    await say({
      text: [
        '*Content Agent Commands:*',
        '',
        '`status` - See current pipeline stats',
        '`ideas` - List unprocessed content ideas',
        '`mine` - Scan recent transcripts for new ideas',
        '`draft <idea-id>` - Start an interview for a specific idea',
        '`help` - Show this message',
        '',
        '*How it works:*',
        '1. I listen to your calls via tldv',
        '2. I extract content ideas from real conversations',
        '3. On schedule, I ping you to interview about the best ones',
        '4. After the interview, I draft content in your voice',
        '5. You approve, edit, or rework the draft',
        '6. LinkedIn posts auto-syndicate to X threads',
      ].join('\n'),
    });
  }

  // --- Session Helpers ---

  /**
   * Find the most recently started active interview session.
   * Used to route non-threaded DMs to the current interview.
   */
  private getLatestActiveSession(): InterviewSession | undefined {
    let latest: InterviewSession | undefined;
    for (const session of this.activeSessions.values()) {
      if (session.status !== 'active') continue;
      if (!latest || session.startedAt > latest.startedAt) {
        latest = session;
      }
    }
    return latest;
  }

  // --- Context ---

  private buildContext() {
    return {
      recentTranscripts: this.transcriptStore.getRecent(7),
      recentIdeas: this.miner.getAllIdeas(),
      interviewHistory: Array.from(this.activeSessions.values()),
      ownerName: config.owner.name,
      postingGoals: {
        linkedinPerWeek: config.goals.linkedinPerWeek,
        newsletterPerWeek: config.goals.newsletterPerWeek,
      },
      voiceProfile: VOICE_PROFILE
    };
  }
}
