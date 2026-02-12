import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import {
  ContentDraft,
  ContentFormat,
  ContentIdea,
  ConversationContext,
  InterviewMessage,
  Transcript,
} from '../types';

export class AIBrain {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  /**
   * Analyze recent transcripts and extract content-worthy ideas.
   * This is the "mining" step - finding gold in real conversations.
   */
  async mineContentIdeas(transcripts: Transcript[]): Promise<ContentIdea[]> {
    if (transcripts.length === 0) return [];

    const transcriptSummaries = transcripts
      .map(
        (t, i) =>
          `--- Transcript ${i + 1}: "${t.title}" (${t.date}) ---\nParticipants: ${t.participants.join(', ')}\n\n${t.content.slice(0, 4000)}`
      )
      .join('\n\n');

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: `You are a content strategist extracting content ideas from real conversations.

Your job is NOT to generate ideas from thin air. You find the ideas that already exist in what was said on calls.

You look for:
- Strong opinions or contrarian takes
- Lessons learned from real experience (not theory)
- Frameworks or mental models explained naturally in conversation
- War stories that illustrate a point (deals won, deals lost, team situations)
- Advice given in a real conversation
- Decisions made and the reasoning behind them
- Anything that challenges conventional wisdom in the speaker's field

For each idea, identify:
1. The core theme
2. A compelling hook — the opening line that would stop the LinkedIn scroll. Write it as if the person said it on a call, not as a content headline.
3. 2-3 direct quotes from the transcript that support it
4. The best format (linkedin_post, youtube_script, newsletter, x_thread)

Respond in JSON format as an array: [{theme, hook, rawQuotes, suggestedFormat}].
Quality over quantity. Max 3 ideas per batch. Skip generic/obvious ideas — only extract things that are genuinely share-worthy and come from real experience.`,
      messages: [
        {
          role: 'user',
          content: `Here are recent call transcripts. Extract content ideas from things that were actually said:\n\n${transcriptSummaries}`,
        },
      ],
    });

    try {
      const text =
        response.content[0].type === 'text' ? response.content[0].text : '';

      console.log(`[ai] Mining response (${text.length} chars): ${text.slice(0, 200)}...`);

      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('[ai] No JSON array found in mining response. Full response:', text.slice(0, 500));
        return [];
      }

      const ideas = JSON.parse(jsonMatch[0]) as Array<{
        theme: string;
        hook: string;
        rawQuotes: string[];
        suggestedFormat: ContentFormat;
      }>;

      console.log(`[ai] Parsed ${ideas.length} ideas from response`);

      return ideas.map((idea, i) => ({
        id: `idea-${Date.now()}-${i}`,
        sourceTranscriptIds: transcripts.map(t => t.id),
        theme: idea.theme,
        hook: idea.hook,
        rawQuotes: idea.rawQuotes || [],
        suggestedFormat: idea.suggestedFormat,
        status: 'extracted' as const,
        createdAt: new Date().toISOString(),
      }));
    } catch (error) {
      console.error('[ai] Failed to parse content ideas:', error);
      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      console.error('[ai] Raw response was:', text.slice(0, 500));
      return [];
    }
  }

  /**
   * Generate the opening interview question for a content idea.
   * This starts the scheduled Slack conversation.
   */
  async generateInterviewOpener(
    idea: ContentIdea,
    context: ConversationContext
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      system: `You are ${context.ownerName}'s AI content agent. You've been listening to their calls and conversations.
Your job is to ping them with a content idea you noticed and start a brief interview to flesh it out.

Be conversational, direct, and specific. Reference what they actually said. Don't be generic.
Keep it to 2-3 sentences max. End with a specific question.

Example tone:
"Hey, I noticed you were talking about pay-as-you-go pricing on your call with [person]. What's the biggest misconception founders have about it?"

Never be sycophantic. Be a sharp content strategist who gets to the point.`,
      messages: [
        {
          role: 'user',
          content: `Here's a content idea I extracted from recent conversations:

Theme: ${idea.theme}
Hook: ${idea.hook}
Quotes from the conversation: ${idea.rawQuotes.map(q => `"${q}"`).join('\n')}
Suggested format: ${idea.suggestedFormat}

Generate an opening message to start interviewing ${context.ownerName} about this. Make it feel natural - like a smart colleague who was in the room.`,
        },
      ],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  /**
   * Generate a follow-up interview question based on the conversation so far.
   */
  async generateFollowUp(
    idea: ContentIdea,
    messages: InterviewMessage[],
    context: ConversationContext
  ): Promise<string> {
    const conversationHistory = messages.map(m => ({
      role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    }));

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      system: `You are ${context.ownerName}'s AI content agent conducting a brief interview to extract a content idea.

Theme: ${idea.theme}
Target format: ${idea.suggestedFormat}

Your goal: Get enough material to write a compelling draft. You need:
- A clear point of view or insight
- Supporting examples or stories
- The "so what" - why this matters to the audience

Rules:
- Ask ONE focused follow-up question at a time
- Dig deeper on interesting points, don't move on too quickly
- If you have enough material (usually after 3-5 exchanges), say "I think I have enough to draft something. Give me a minute." and stop asking questions.
- Be direct and sharp. No filler.`,
      messages: conversationHistory,
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  /**
   * Check if we have enough material from the interview to generate a draft.
   */
  async hasEnoughMaterial(messages: InterviewMessage[]): Promise<boolean> {
    if (messages.length < 4) return false; // Need at least 2 exchanges
    if (messages.length >= 10) return true; // Cap it

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 50,
      system:
        'You evaluate whether an interview has enough material to write content. Respond with just "yes" or "no".',
      messages: [
        {
          role: 'user',
          content: `Here's the interview so far:\n\n${messages.map(m => `${m.role}: ${m.content}`).join('\n\n')}\n\nIs there enough material for a compelling content draft?`,
        },
      ],
    });

    const answer =
      response.content[0].type === 'text'
        ? response.content[0].text.toLowerCase().trim()
        : 'no';
    return answer.includes('yes');
  }

  /**
   * Generate a content draft from interview material.
   */
  async generateDraft(
    idea: ContentIdea,
    messages: InterviewMessage[],
    format: ContentFormat,
    context: ConversationContext
  ): Promise<ContentDraft> {
    const interviewText = messages
      .map(m => `${m.role === 'agent' ? 'Interviewer' : context.ownerName}: ${m.content}`)
      .join('\n\n');

    const formatInstructions = this.getFormatInstructions(format);

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: `You are ${context.ownerName}'s ghostwriter. You write like ${context.ownerName} talks — direct, opinionated, grounded in real stories.

${context.voiceProfile ? `${context.voiceProfile}\n` : ''}

## Copywriting Rules
- Write as ${context.ownerName}, first person, always
- Every claim MUST be backed by something they actually said in the interview or on a call
- No generic advice — only specific, experience-based insights with named situations
- The first line must stop the scroll — bold claim, surprising story, or contrarian take
- One core idea per piece. Go deep, not wide.
- Use short paragraphs (1-2 sentences) with line breaks for mobile readability
- End with a question that invites genuine discussion or a clear, specific takeaway
- Frame problems using loss aversion: "What happens if you don't fix this?" not "Here's why you should fix this"
- Use social proof naturally: "Most teams at this stage..." or "When [similar company] hit this..."
- Specificity > generality: name the city, name the team size, name the outcome

## Anti-Patterns (NEVER do these)
- No AI slop: "In today's fast-paced world", "Let me be honest", "Here's the thing", "Let's dive in"
- No corporate buzzwords: "synergy", "thought leadership", "value-add", "paradigm shift"
- No superlatives: "best in class", "industry-leading", "cutting-edge"
- No rhetorical question openers: "Tired of...?", "What if you could...?"
- No hashtag spam
- No generic CTAs like "Drop a comment below!" — if there's a question, make it one people actually want to answer

${formatInstructions}`,
      messages: [
        {
          role: 'user',
          content: `Write a ${this.formatLabel(format)} based on this interview:

Theme: ${idea.theme}
Original hook: ${idea.hook}
Raw quotes from calls: ${idea.rawQuotes.map(q => `"${q}"`).join('\n')}

Interview transcript:
${interviewText}

Write the draft now. Make it sharp.`,
        },
      ],
    });

    const body =
      response.content[0].type === 'text' ? response.content[0].text : '';

    return {
      id: `draft-${Date.now()}`,
      ideaId: idea.id,
      format,
      title: idea.hook,
      body,
      version: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Rework a draft based on user feedback.
   * Takes the original draft body, the user's feedback, and produces a new version.
   */
  async reworkDraft(
    originalBody: string,
    feedback: string,
    format: ContentFormat,
    context: ConversationContext
  ): Promise<string> {
    const formatInstructions = this.getFormatInstructions(format);

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: `You are ${context.ownerName}'s ghostwriter reworking a content draft based on their feedback.

${context.voiceProfile ? `${context.voiceProfile}\n` : ''}

Keep what works from the original. Apply the feedback precisely — don't over-correct or change things the user didn't ask about.

${formatInstructions}`,
      messages: [
        {
          role: 'user',
          content: `Here's the original draft:\n\n${originalBody}\n\n---\n\nFeedback from ${context.ownerName}:\n${feedback}\n\nRework the draft based on this feedback. Return ONLY the reworked draft, no commentary.`,
        },
      ],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  /**
   * Convert a LinkedIn post into an X/Twitter thread.
   */
  async syndicateToXThread(linkedinPost: string, context: ConversationContext): Promise<string> {
    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      system: `You convert LinkedIn posts into X (Twitter) threads.

Rules:
- Break into tweets of max 280 characters each
- Number each tweet (1/, 2/, etc.)
- First tweet should be the hook - make people want to read the thread
- Keep ${context.ownerName}'s voice intact
- Don't add hashtags unless they were in the original
- Aim for 3-7 tweets
- End with a clear CTA or takeaway`,
      messages: [
        {
          role: 'user',
          content: `Convert this LinkedIn post to an X thread:\n\n${linkedinPost}`,
        },
      ],
    });

    return response.content[0].type === 'text' ? response.content[0].text : '';
  }

  private getFormatInstructions(format: ContentFormat): string {
    switch (format) {
      case 'linkedin_post':
        return `FORMAT: LinkedIn Post
- 150-300 words
- Short paragraphs (1-2 sentences max) with a blank line between each
- Hook in the FIRST LINE — bold claim, story opener, or contrarian take that stops the scroll
- Structure: Hook -> Story/Context -> Insight -> Takeaway/Question
- Use line breaks aggressively for mobile readability
- Call out a specific audience where relevant
- End with a genuine question people want to answer, NOT "Agree? Drop a comment!"
- No hashtags unless they genuinely add discoverability
- Use loss aversion framing: cost of inaction > benefits of action
- Name real situations: cities, team sizes, outcomes, specific companies`;

      case 'youtube_script':
        return `FORMAT: YouTube Script
- 3-5 minute read time
- Start with a hook (first 10 seconds matter)
- Include [B-ROLL] or [CUT TO] markers where visual changes would happen
- Conversational tone - write for speaking, not reading
- End with a CTA (subscribe, comment, etc.)`;

      case 'newsletter':
        return `FORMAT: Newsletter
- 500-800 words
- Clear subject line at the top
- TL;DR in the first paragraph
- Use headers to break sections
- One key insight or framework
- Personal and direct tone`;

      case 'x_thread':
        return `FORMAT: X/Twitter Thread
- 3-7 tweets
- Each tweet max 280 characters
- Number format: 1/, 2/, etc.
- First tweet is the hook
- Last tweet is the takeaway`;

      default:
        return '';
    }
  }

  private formatLabel(format: ContentFormat): string {
    const labels: Record<ContentFormat, string> = {
      linkedin_post: 'LinkedIn post',
      youtube_script: 'YouTube script',
      newsletter: 'newsletter',
      x_thread: 'X thread',
    };
    return labels[format] || format;
  }
}
