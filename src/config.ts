import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514',
  },
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET'),
    appToken: required('SLACK_APP_TOKEN'),
    userId: required('SLACK_USER_ID'),
  },
  tldv: {
    apiKey: optional('TLDV_API_KEY', ''),
  },
  notion: {
    apiKey: required('NOTION_API_KEY'),
    contentDbId: required('NOTION_CONTENT_DB_ID'),
    transcriptsDbId: required('NOTION_TRANSCRIPTS_DB_ID'),
  },
  server: {
    port: parseInt(optional('PORT', '3100'), 10),
  },
  schedule: {
    contentPingCron: optional('CONTENT_PING_CRON', '0 9 * * 1,3,5'),
  },
  owner: {
    name: optional('OWNER_NAME', 'Boss'),
  },
  goals: {
    linkedinPerWeek: parseInt(optional('LINKEDIN_POSTS_PER_WEEK', '3'), 10),
    newsletterPerWeek: parseInt(optional('NEWSLETTER_PER_WEEK', '1'), 10),
  },
};
