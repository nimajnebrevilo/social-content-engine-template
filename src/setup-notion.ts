/**
 * One-time setup script to create the required Notion databases.
 *
 * Usage:
 *   NOTION_API_KEY=secret_... NOTION_PARENT_PAGE_ID=... npx tsx src/setup-notion.ts
 *
 * The NOTION_PARENT_PAGE_ID is the page where databases will be created.
 * Get it from the Notion URL: notion.so/workspace/<PAGE_ID>
 */

import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

if (!NOTION_API_KEY) {
  console.error('Missing NOTION_API_KEY environment variable');
  console.error('Get one at: https://www.notion.so/my-integrations');
  process.exit(1);
}

if (!PARENT_PAGE_ID) {
  console.error('Missing NOTION_PARENT_PAGE_ID environment variable');
  console.error('Create a page in Notion, then copy the page ID from the URL.');
  console.error('Example URL: https://notion.so/workspace/My-Page-abc123def456');
  console.error('The page ID is the last part: abc123def456');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

async function createTranscriptsDb(): Promise<string> {
  console.log('Creating Transcripts database...');

  const response = await notion.databases.create({
    parent: { type: 'page_id', page_id: PARENT_PAGE_ID! },
    title: [{ type: 'text', text: { content: 'Call Transcripts' } }],
    properties: {
      Title: { title: {} },
      'Meeting ID': { rich_text: {} },
      Date: { date: {} },
      Participants: { rich_text: {} },
      Source: {
        select: {
          options: [
            { name: 'tldv', color: 'blue' },
            { name: 'manual', color: 'gray' },
          ],
        },
      },
      'Transcript ID': { rich_text: {} },
    },
  });

  console.log(`  Created: ${response.id}`);
  return response.id;
}

async function createContentDb(): Promise<string> {
  console.log('Creating Content database...');

  const response = await notion.databases.create({
    parent: { type: 'page_id', page_id: PARENT_PAGE_ID! },
    title: [{ type: 'text', text: { content: 'Content Pipeline' } }],
    properties: {
      Title: { title: {} },
      Theme: { rich_text: {} },
      Format: {
        select: {
          options: [
            { name: 'LinkedIn Post', color: 'blue' },
            { name: 'YouTube Script', color: 'red' },
            { name: 'Newsletter', color: 'green' },
            { name: 'X Thread', color: 'default' },
          ],
        },
      },
      Status: {
        select: {
          options: [
            { name: 'extracted', color: 'gray' },
            { name: 'interviewing', color: 'yellow' },
            { name: 'drafting', color: 'orange' },
            { name: 'draft_ready', color: 'blue' },
            { name: 'approved', color: 'green' },
            { name: 'published', color: 'purple' },
          ],
        },
      },
      'Created At': { date: {} },
    },
  });

  console.log(`  Created: ${response.id}`);
  return response.id;
}

async function main() {
  console.log('Setting up Notion databases for Content Agent...\n');

  try {
    const transcriptsDbId = await createTranscriptsDb();
    const contentDbId = await createContentDb();

    console.log('\nDone! Add these to your .env file:\n');
    console.log(`NOTION_TRANSCRIPTS_DB_ID=${transcriptsDbId}`);
    console.log(`NOTION_CONTENT_DB_ID=${contentDbId}`);
    console.log('\n(You can remove NOTION_PARENT_PAGE_ID from .env now)');
  } catch (error: any) {
    if (error.code === 'object_not_found') {
      console.error('\nError: Page not found. Make sure you:');
      console.error('1. Shared the page with your Notion integration');
      console.error('2. Used the correct page ID from the URL');
    } else {
      console.error('\nError:', error.message || error);
    }
    process.exit(1);
  }
}

main();
