export interface Transcript {
  id: string;
  meetingId: string;
  title: string;
  date: string;
  participants: string[];
  content: string;
  source: 'tldv' | 'manual';
  processedAt?: string;
  themes?: string[];
  keyInsights?: string[];
  notionPageId?: string;
}

export interface ContentIdea {
  id: string;
  sourceTranscriptIds: string[];
  theme: string;
  hook: string;
  rawQuotes: string[];
  suggestedFormat: ContentFormat;
  status: 'extracted' | 'interviewing' | 'drafting' | 'draft_ready' | 'published';
  createdAt: string;
  notionPageId?: string;
}

export type ContentFormat = 'linkedin_post' | 'youtube_script' | 'newsletter' | 'x_thread';

export interface ContentDraft {
  id: string;
  ideaId: string;
  format: ContentFormat;
  title: string;
  body: string;
  version: number;
  status: 'draft' | 'review' | 'approved' | 'published';
  createdAt: string;
  notionPageId?: string;
}

export interface InterviewSession {
  id: string;
  ideaId: string;
  slackThreadTs: string;
  messages: InterviewMessage[];
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
}

export interface InterviewMessage {
  role: 'agent' | 'user';
  content: string;
  timestamp: string;
}

export interface ConversationContext {
  recentTranscripts: Transcript[];
  recentIdeas: ContentIdea[];
  interviewHistory: InterviewSession[];
  ownerName: string;
  postingGoals: PostingGoals;
  voiceProfile: string;
}

export interface PostingGoals {
  linkedinPerWeek: number;
  newsletterPerWeek: number;
}

export interface TldvWebhookPayload {
  event: string;
  meeting: {
    id: string;
    title: string;
    date: string;
    duration: number;
    participants: Array<{
      name: string;
      email?: string;
    }>;
  };
  transcript?: {
    text: string;
    segments?: Array<{
      speaker: string;
      text: string;
      start: number;
      end: number;
    }>;
  };
}

export interface SlackInteractionContext {
  userId: string;
  channelId: string;
  threadTs?: string;
  text: string;
}
