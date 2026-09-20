import { describe, expect, it } from 'vitest';
import { computePresence, mergeSegments } from '@/modules/attendance/attendance.engine';
import type { IPresenceSegment } from '@/models/attendance.model';

/**
 * These cover the pure half of the engine — the part that decides whether a
 * student is marked present. The database half is exercised by running a real
 * class; this is what must never silently change.
 */

const START = new Date('2026-01-10T10:00:00Z');
const END = new Date('2026-01-10T11:00:00Z'); // a 60-minute class
const MIN = 60_000;

const seg = (fromMin: number, toMin: number | null): IPresenceSegment => ({
  joinedAt: new Date(START.getTime() + fromMin * MIN),
  leftAt: toMin === null ? null : new Date(START.getTime() + toMin * MIN),
  openedBy: 'webhook',
  closedBy: toMin === null ? null : 'webhook',
});

describe('mergeSegments', () => {
  it('clamps a segment that starts before the class did', () => {
    const merged = mergeSegments([seg(-20, 30)], START, END);
    expect(merged).toEqual([{ start: START.getTime(), end: START.getTime() + 30 * MIN }]);
  });

  it('clamps a segment running past the end of the class', () => {
    const merged = mergeSegments([seg(40, 90)], START, END);
    expect(merged[0]!.end).toBe(END.getTime());
  });

  it('counts overlapping segments once', () => {
    const merged = mergeSegments([seg(0, 30), seg(20, 45)], START, END);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.end - merged[0]!.start).toBe(45 * MIN);
  });

  it('keeps disjoint segments separate', () => {
    const merged = mergeSegments([seg(0, 10), seg(30, 40)], START, END);
    expect(merged).toHaveLength(2);
  });

  it('treats a still-open segment as running to the end of the window', () => {
    const merged = mergeSegments([seg(10, null)], START, END);
    expect(merged[0]!.end).toBe(END.getTime());
  });

  it('drops a segment that falls entirely outside the class window', () => {
    const before: IPresenceSegment = {
      joinedAt: new Date(START.getTime() - 60 * MIN),
      leftAt: new Date(START.getTime() - 30 * MIN),
      openedBy: 'webhook',
      closedBy: 'webhook',
    };
    expect(mergeSegments([before], START, END)).toEqual([]);
  });
});

describe('computePresence at a 60% threshold', () => {
  it('marks a student present at exactly the threshold', () => {
    const result = computePresence([seg(0, 36)], START, END, 60);
    expect(result.presencePct).toBe(60);
    expect(result.status).toBe('present');
  });

  it('marks a student partial one minute short of the threshold', () => {
    const result = computePresence([seg(0, 35)], START, END, 60);
    expect(result.presencePct).toBeCloseTo(58.33, 2);
    expect(result.status).toBe('partial');
  });

  it('adds up a student who dropped out and rejoined', () => {
    const result = computePresence([seg(0, 20), seg(25, 45), seg(50, 60)], START, END, 60);
    expect(result.totalPresentMs).toBe(50 * MIN);
    expect(result.status).toBe('present');
  });

  it('marks a no-show absent, not partial', () => {
    const result = computePresence([], START, END, 60);
    expect(result).toEqual({ totalPresentMs: 0, presencePct: 0, status: 'absent' });
  });

  it('gives no credit for time banked before the class started', () => {
    // In the room from 20 minutes early until 30 minutes in: 30 of 60 real minutes.
    const result = computePresence([seg(-20, 30)], START, END, 60);
    expect(result.presencePct).toBe(50);
    expect(result.status).toBe('partial');
  });

  it('measures against the actual duration, not the scheduled one', () => {
    // Scheduled for 60 minutes but ended after 30. A student present for 25 of
    // those 30 minutes attended the whole class that was actually held.
    const shortEnd = new Date(START.getTime() + 30 * MIN);
    const result = computePresence([seg(0, 25)], START, shortEnd, 60);
    expect(result.presencePct).toBeCloseTo(83.33, 2);
    expect(result.status).toBe('present');
  });

  it('never reports more than 100%', () => {
    const result = computePresence([seg(-30, 120)], START, END, 60);
    expect(result.presencePct).toBe(100);
  });

  it('treats a class that ran under a minute as not held', () => {
    const instantEnd = new Date(START.getTime() + 10_000);
    const result = computePresence([seg(0, null)], START, instantEnd, 60);
    expect(result.status).toBe('absent');
  });
});
