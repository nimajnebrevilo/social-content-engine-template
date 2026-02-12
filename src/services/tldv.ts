import { config } from '../config';
import { Transcript } from '../types';
import { TranscriptStore } from './transcript-store';
import { ContentMiner } from './content-miner';

interface TldvMeeting {
  id: string;
  name: string;
  happenedAt: string;
  duration: number;
  invitees: Array<{ name: string; email?: string }>;
  organizer?: { name: string; email?: string };
  url?: string;
}

interface TldvTranscriptSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/**
 * TldvService polls the tldv REST API for new meetings and transcripts.
 * No webhook required - runs on a schedule alongside the content mining cycle.
 *
 * API docs: https://doc.tldv.io
 * Base URL: https://pasta.tldv.io/v1alpha1
 */
export class TldvService {
  private baseUrl = 'https://pasta.tldv.io/v1alpha1';
  private transcriptStore: TranscriptStore;
  private contentMiner: ContentMiner;
  private seenMeetingIds: Set<string> = new Set();

  constructor(transcriptStore: TranscriptStore, contentMiner: ContentMiner) {
    this.transcriptStore = transcriptStore;
    this.contentMiner = contentMiner;
  }

  /**
   * Poll tldv for new meetings since the last check.
   * Called by the scheduler alongside content mining.
   */
  async pollNewMeetings(): Promise<Transcript[]> {
    if (!config.tldv.apiKey) {
      console.log('[tldv] No API key configured, skipping poll');
      return [];
    }

    try {
      // Fetch recent meetings (last 30 days)
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const meetings = await this.listMeetings(since.toISOString());

      // Client-side date filter (tldv API may ignore the 'from' param)
      const sinceTime = since.getTime();
      const filteredMeetings = meetings.filter(m => {
        try {
          return new Date(m.happenedAt).getTime() >= sinceTime;
        } catch {
          return true; // Include if we can't parse the date
        }
      });

      console.log(`[tldv] ${filteredMeetings.length} meetings in last 30 days (${meetings.length} total fetched)`);
      const newTranscripts: Transcript[] = [];

      for (const meeting of filteredMeetings) {
        // Skip already-processed meetings
        if (this.seenMeetingIds.has(meeting.id)) continue;
        if (this.transcriptStore.get(`tldv-${meeting.id}`)) {
          this.seenMeetingIds.add(meeting.id);
          continue;
        }

        // Fetch transcript for this meeting
        const transcriptText = await this.getTranscript(meeting.id);
        if (!transcriptText) {
          console.log(`[tldv] No transcript ready for: "${meeting.name}"`);
          continue;
        }

        const participants = (meeting.invitees || [])
          .map(p => p.name || p.email || 'Unknown')
          .filter(n => n !== 'Unknown');

        // Convert tldv's date format to ISO 8601 for Notion compatibility
        let meetingDate: string;
        try {
          meetingDate = new Date(meeting.happenedAt).toISOString();
        } catch {
          meetingDate = new Date().toISOString();
          console.warn(`[tldv] Could not parse date "${meeting.happenedAt}", using current date`);
        }

        const transcript: Transcript = {
          id: `tldv-${meeting.id}`,
          meetingId: meeting.id,
          title: meeting.name,
          date: meetingDate,
          participants,
          content: transcriptText,
          source: 'tldv',
        };

        console.log(`[tldv] New transcript: "${transcript.title}"`);

        await this.transcriptStore.save(transcript);
        this.seenMeetingIds.add(meeting.id);
        newTranscripts.push(transcript);
      }

      if (newTranscripts.length > 0) {
        console.log(`[tldv] Fetched ${newTranscripts.length} new transcripts`);

        // Queue for content mining
        for (const t of newTranscripts) {
          this.contentMiner.queueTranscript(t).catch(err => {
            console.error('[tldv] Error queuing transcript:', err);
          });
        }
      }

      return newTranscripts;
    } catch (error) {
      console.error('[tldv] Error polling for meetings:', error);
      return [];
    }
  }

  /**
   * List meetings from tldv API with pagination to fetch all results.
   */
  private async listMeetings(since?: string): Promise<TldvMeeting[]> {
    const allMeetings: TldvMeeting[] = [];
    let offset = 0;
    const limit = 100;
    const maxMeetings = 500; // Cap to avoid fetching too many meetings

    while (allMeetings.length < maxMeetings) {
      const params = new URLSearchParams();
      if (since) params.set('from', since);
      params.set('limit', String(limit));
      params.set('offset', String(offset));

      const response = await fetch(
        `${this.baseUrl}/meetings?${params.toString()}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.tldv.apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`tldv API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as Record<string, any>;
      const meetings: TldvMeeting[] = data.results || data.meetings || (Array.isArray(data) ? data : []);

      if (meetings.length === 0) break;

      allMeetings.push(...meetings);
      console.log(`[tldv] Fetched page ${Math.floor(offset / limit) + 1}: ${meetings.length} meetings (${allMeetings.length} total)`);

      // If we got fewer than the limit, we've reached the end
      if (meetings.length < limit) break;

      offset += limit;
    }

    return allMeetings;
  }

  /**
   * Get transcript for a specific meeting.
   */
  private async getTranscript(meetingId: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/meetings/${meetingId}/transcript`,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.tldv.apiKey,
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) return null; // Transcript not ready yet
        throw new Error(`tldv API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as Record<string, any>;

      // Format transcript segments into readable text
      if (data.segments && Array.isArray(data.segments)) {
        return (data.segments as TldvTranscriptSegment[])
          .map(seg => `${seg.speaker}: ${seg.text}`)
          .join('\n');
      }

      // Fallback: return raw text if available
      if (typeof data === 'string') return data;
      if (data.text) return data.text as string;
      if (data.transcript) return data.transcript as string;

      return JSON.stringify(data);
    } catch (error) {
      console.error(`[tldv] Error fetching transcript for ${meetingId}:`, error);
      return null;
    }
  }

  /**
   * Get AI-generated highlights/notes for a meeting.
   * Useful as supplementary context for content mining.
   */
  async getHighlights(meetingId: string): Promise<string | null> {
    if (!config.tldv.apiKey) return null;

    try {
      const response = await fetch(
        `${this.baseUrl}/meetings/${meetingId}/highlights`,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.tldv.apiKey,
          },
        }
      );

      if (!response.ok) return null;

      const data = await response.json() as any;
      if (Array.isArray(data)) {
        return data.map((h: any) => h.text || h.content || '').join('\n');
      }
      return data.text || data.content || null;
    } catch {
      return null;
    }
  }
}
