import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/providers', () => ({ generateText: vi.fn() }));
import { parseInsight, relevantSegments, splitTranscript } from '../server/intelligence';
import type { Segment } from '../shared/types';
const segments: Segment[] = [{ id: 's1', start: 0, end: 4, text: 'Maya will send the proposal on Friday.', words: [] }, { id: 's2', start: 4, end: 8, text: 'We approved the launch.', words: [] }];
describe('transcript grounded notes', () => {
  it('keeps valid evidence and strips invented segment references', () => { const notes = parseInsight('```json\n{"summary":"Launch planning","decisions":["Approved"],"actions":[{"text":"Send proposal","owner":"Maya","segmentId":"s1"},{"text":"Other","segmentId":"madeup"}]}\n```', segments); expect(notes.actions[0].segmentId).toBe('s1'); expect(notes.actions[1].segmentId).toBeUndefined(); expect(notes.actions[0].done).toBe(false); });
  it('rejects prose-only and malformed note responses', () => { expect(() => parseInsight('Here are notes', segments)).toThrow('structured'); expect(() => parseInsight('{"summary":"Hello"}', segments)).toThrow('incomplete'); });
  it('preserves chronological evidence across chunk boundaries', () => { const chunks = splitTranscript(segments, 25); expect(chunks).toHaveLength(2); expect(chunks.flat()).toEqual(segments); });
  it('retrieves matching material from the end of long meetings', () => { const long = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, start: i * 4, end: i * 4 + 4, text: i === 499 ? 'The zephyr budget is approved.' : 'Routine conversation and many unrelated details.'.repeat(4), words: [] })); expect(relevantSegments(long, 'What about zephyr?', 1000).some(s => s.id === 's499')).toBe(true); });
});
