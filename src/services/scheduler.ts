import cron from 'node-cron';
import { config } from '../config';
import { ContentMiner } from './content-miner';
import { TranscriptStore } from './transcript-store';
import { SlackBot } from './slack-bot';
import { TldvService } from './tldv';

/**
 * Scheduler handles two jobs:
 *
 * 1. tldv polling - checks for new meeting transcripts every 30 minutes
 * 2. Content ping - scheduled interviews about extracted ideas
 */
export class Scheduler {
  private miner: ContentMiner;
  private transcriptStore: TranscriptStore;
  private slackBot: SlackBot;
  private tldv: TldvService;
  private contentTask: cron.ScheduledTask | null = null;
  private pollTask: cron.ScheduledTask | null = null;

  constructor(
    miner: ContentMiner,
    transcriptStore: TranscriptStore,
    slackBot: SlackBot,
    tldv: TldvService
  ) {
    this.miner = miner;
    this.transcriptStore = transcriptStore;
    this.slackBot = slackBot;
    this.tldv = tldv;
  }

  start(): void {
    // tldv polling - every 30 minutes
    this.pollTask = cron.schedule('*/30 * * * *', async () => {
      console.log('[scheduler] Polling tldv for new transcripts...');
      await this.tldv.pollNewMeetings();
    });
    console.log('[scheduler] tldv polling active (every 30 min)');

    // Content mining + Slack ping (configurable cron)
    const cronExpression = config.schedule.contentPingCron;
    this.contentTask = cron.schedule(cronExpression, async () => {
      console.log('[scheduler] Running content mining cycle...');
      await this.runContentCycle();
    });
    console.log(`[scheduler] Content ping active (cron: ${cronExpression})`);
  }

  stop(): void {
    if (this.contentTask) {
      this.contentTask.stop();
      this.contentTask = null;
    }
    if (this.pollTask) {
      this.pollTask.stop();
      this.pollTask = null;
    }
    console.log('[scheduler] Stopped');
  }

  /**
   * Run a single content mining + ping cycle.
   * Can also be triggered manually via Slack "mine" command.
   */
  async runContentCycle(): Promise<void> {
    try {
      // Step 0: Poll tldv first to get latest transcripts
      await this.tldv.pollNewMeetings();

      // Step 1: Check for unprocessed ideas
      let ideas = this.miner.getUnprocessedIdeas();

      // Step 2: If no ideas, mine recent transcripts
      if (ideas.length === 0) {
        const recentTranscripts = this.transcriptStore.getRecent(7);

        if (recentTranscripts.length === 0) {
          console.log('[scheduler] No recent transcripts to mine. Skipping.');
          return;
        }

        console.log(
          `[scheduler] Mining ${recentTranscripts.length} recent transcripts...`
        );
        ideas = await this.miner.mineFromTranscripts(recentTranscripts);

        if (ideas.length === 0) {
          console.log('[scheduler] No content ideas extracted. Skipping.');
          return;
        }
      }

      // Step 3: Pick the best idea (first unprocessed one)
      const bestIdea = ideas[0];
      console.log(
        `[scheduler] Selected idea for interview: "${bestIdea.hook}"`
      );

      // Step 4: Ping in Slack
      await this.slackBot.sendContentPing(bestIdea);
      console.log('[scheduler] Content ping sent to Slack');
    } catch (error) {
      console.error('[scheduler] Error in content cycle:', error);
    }
  }
}
