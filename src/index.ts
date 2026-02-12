import { config } from './config';
import { AIBrain } from './services/ai-brain';
import { ContentMiner } from './services/content-miner';
import { NotionService } from './services/notion';
import { Scheduler } from './services/scheduler';
import { SlackBot } from './services/slack-bot';
import { TldvService } from './services/tldv';
import { TranscriptStore } from './services/transcript-store';

async function main() {
  console.log('Starting Content Agent...');
  console.log(`Owner: ${config.owner.name}`);
  console.log(`Schedule: ${config.schedule.contentPingCron}`);
  console.log(`Goals: ${config.goals.linkedinPerWeek} LinkedIn/week, ${config.goals.newsletterPerWeek} newsletter/week`);

  // Initialize services
  const notion = new NotionService();
  const brain = new AIBrain();
  const transcriptStore = new TranscriptStore(notion);
  const miner = new ContentMiner(brain, notion);
  const slackBot = new SlackBot(brain, miner, transcriptStore, notion);
  const tldvService = new TldvService(transcriptStore, miner);
  const scheduler = new Scheduler(miner, transcriptStore, slackBot, tldvService);

  // Ensure Notion DB schemas are up to date
  await notion.ensureContentDbSchema();

  // Load existing transcripts from Notion
  console.log('Loading transcripts from Notion...');
  await transcriptStore.loadFromNotion();

  // Load existing content ideas from Notion (persists across restarts)
  // Pass all transcript IDs so legacy ideas (without sourceTranscriptIds) mark all transcripts as mined
  console.log('Loading content ideas from Notion...');
  const allTranscriptIds = transcriptStore.getAll().map(t => t.id);
  await miner.loadFromNotion(allTranscriptIds);

  // Start Slack bot (socket mode - no server needed)
  await slackBot.start();

  // Initial tldv poll to seed transcripts
  if (config.tldv.apiKey) {
    console.log('Polling tldv for recent transcripts...');
    const initial = await tldvService.pollNewMeetings();
    console.log(`Loaded ${initial.length} new transcripts from tldv`);
  } else {
    console.log('No tldv API key - skipping initial poll');
  }

  // Start the scheduler
  scheduler.start();

  console.log('\nContent Agent is live.');
  console.log(`- Slack: listening for DMs`);
  console.log(`- tldv: polling every 30 min${config.tldv.apiKey ? '' : ' (no API key - disabled)'}`);
  console.log(`- Notion: connected`);
  console.log(`\nSay "help" in Slack to see available commands.`);

  // Catch unhandled errors to prevent silent crashes
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[process] Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[process] Uncaught exception:', error);
    // Don't exit — let the process keep running
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    scheduler.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
