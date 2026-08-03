import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  batchSize,
  inboundIntent,
  isDue,
  isExhausted,
  messageCost,
  nextAttemptAfter,
  queueHealth,
  selectDue,
  type Queued,
} from './messaging';

const T0 = new Date('2027-07-24T14:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function queued(over: Partial<Queued> = {}): Queued {
  return {
    id: 'n1',
    recipient: '+16135550142',
    body: 'MA-01 final: Kanata 5, Orleans 3.',
    kind: 'score_approved',
    status: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: T0,
    ...over,
  };
}

describe('retrying a failed send', () => {
  it('backs off further each time', () => {
    const waits = [1, 2, 3, 4].map((attempts) => {
      const next = nextAttemptAfter(attempts, T0)!;
      return (next.getTime() - T0.getTime()) / 1000;
    });
    expect(waits).toEqual(BACKOFF_SECONDS);
    // Strictly increasing, which is the property that matters.
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });

  it('gives up rather than hammering a dead number', () => {
    expect(nextAttemptAfter(MAX_ATTEMPTS, T0)).toBeNull();
    expect(isExhausted(MAX_ATTEMPTS)).toBe(true);
    expect(isExhausted(MAX_ATTEMPTS - 1)).toBe(false);
  });
});

describe('deciding what to send now', () => {
  it('sends a fresh message immediately', () => {
    expect(isDue(queued(), T0)).toBe(true);
  });

  it('waits until a backed-off message comes due', () => {
    const message = queued({ status: 'failed', attempts: 1, nextAttemptAt: at(5) });
    expect(isDue(message, at(4))).toBe(false);
    expect(isDue(message, at(5))).toBe(true);
  });

  it('never resends something already sent or cancelled', () => {
    expect(isDue(queued({ status: 'sent' }), T0)).toBe(false);
    expect(isDue(queued({ status: 'cancelled' }), T0)).toBe(false);
  });

  it('leaves a message that is mid-flight alone', () => {
    // A crashed run leaves 'sending' behind. Picking it up again could send the
    // same text twice, which is worse than sending it late.
    expect(isDue(queued({ status: 'sending' }), at(60))).toBe(false);
  });

  it('leaves an exhausted message for a human', () => {
    expect(isDue(queued({ status: 'failed', attempts: MAX_ATTEMPTS }), at(600))).toBe(false);
  });

  it('sends the oldest first, so a retry does not queue behind new traffic', () => {
    const chosen = selectDue(
      [
        queued({ id: 'new', createdAt: at(30) }),
        queued({ id: 'old-retry', status: 'failed', attempts: 1, nextAttemptAt: at(10), createdAt: T0 }),
        queued({ id: 'middle', createdAt: at(15) }),
      ],
      at(40),
      2,
    );
    expect(chosen.map((m) => m.id)).toEqual(['old-retry', 'middle']);
  });

  it('respects the batch limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => queued({ id: `n${i}` }));
    expect(selectDue(many, T0, 5)).toHaveLength(5);
  });
});

describe('reading an inbound message as an instruction', () => {
  it('recognises the words carriers require', () => {
    for (const word of ['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'quit', 'end']) {
      expect(inboundIntent(word)).toBe('stop');
    }
    expect(inboundIntent('START')).toBe('start');
    expect(inboundIntent('help')).toBe('help');
  });

  it('tolerates punctuation and whitespace', () => {
    expect(inboundIntent('  stop. ')).toBe('stop');
    expect(inboundIntent('STOP!')).toBe('stop');
  });

  it('does not silence somebody for using the word in a sentence', () => {
    // This is the failure that matters: read as an opt-out, this coach hears
    // nothing for the rest of the weekend.
    expect(inboundIntent('stop the game, it is raining')).toBeNull();
    expect(inboundIntent('7-2, stop')).toBeNull();
    expect(inboundIntent('can you tell them to stop')).toBeNull();
  });

  it('reads an ordinary score as nothing at all', () => {
    expect(inboundIntent('MA-01 5-3')).toBeNull();
    expect(inboundIntent('')).toBeNull();
  });
});

describe('what a message costs to send', () => {
  it('counts a plain short message as one cheap segment', () => {
    const cost = messageCost('MA-01 final: Kanata 5, Orleans 3.');
    expect(cost).toMatchObject({ encoding: 'GSM-7', segments: 1 });
  });

  it('splits a long message into concatenated segments', () => {
    expect(messageCost('a'.repeat(160)).segments).toBe(1);
    // Over 160, each segment loses 7 characters to the joining header.
    expect(messageCost('a'.repeat(161)).segments).toBe(2);
    expect(messageCost('a'.repeat(306)).segments).toBe(2);
    expect(messageCost('a'.repeat(307)).segments).toBe(3);
  });

  it('catches the smart quote that triples the bill', () => {
    // A curly apostrophe is not in GSM-7, so the whole message becomes UCS-2
    // and the segment size drops from 160 to 70 — invisible on screen.
    const straight = messageCost("The coaches' meeting is at 8pm sharp in the clubhouse tonight.");
    const curly = messageCost("The coaches’ meeting is at 8pm sharp in the clubhouse tonight.");

    expect(straight.encoding).toBe('GSM-7');
    expect(straight.segments).toBe(1);
    expect(curly.encoding).toBe('UCS-2');
    expect(curly.segments).toBe(1);
    expect(curly.offenders).toEqual(['’']);
  });

  it('counts an emoji as expensive', () => {
    const cost = messageCost('Kanata win 🏆');
    expect(cost.encoding).toBe('UCS-2');
    expect(cost.offenders.length).toBeGreaterThan(0);
  });

  it('charges two characters for the GSM extended set', () => {
    // A euro sign or a square bracket costs double in GSM-7.
    expect(messageCost('[').characters).toBe(2);
    expect(messageCost('a').characters).toBe(1);
  });

  it('costs an empty message nothing', () => {
    expect(messageCost('').segments).toBe(0);
  });
});

describe('rate limiting a broadcast', () => {
  it('never sends less than one at a time', () => {
    expect(batchSize(1, 0.5)).toBe(1);
  });

  it('scales with the tick length', () => {
    expect(batchSize(1, 10)).toBe(10);
    expect(batchSize(10, 6)).toBe(60);
  });
});

describe('what the queue looks like to a director', () => {
  it('separates what is waiting from what is stuck', () => {
    const health = queueHealth(
      [
        queued({ status: 'sent' }),
        queued({ status: 'queued', createdAt: at(-30) }),
        queued({ status: 'failed', attempts: 1 }),
        queued({ status: 'failed', attempts: MAX_ATTEMPTS }),
        queued({ status: 'cancelled' }),
      ],
      T0,
    );

    expect(health).toMatchObject({ sent: 1, queued: 1, failed: 2, cancelled: 1, stuck: 1 });
  });

  it('reports how long the oldest thing has been waiting', () => {
    const health = queueHealth([queued({ createdAt: at(-45) }), queued({ createdAt: at(-5) })], T0);
    expect(health.oldestWaitingMinutes).toBe(45);
  });

  it('does not count a sent message as waiting', () => {
    const health = queueHealth([queued({ status: 'sent', createdAt: at(-600) })], T0);
    expect(health.oldestWaitingMinutes).toBeNull();
  });

  it('totals the segments, because that is the bill', () => {
    const health = queueHealth([queued({ body: 'a'.repeat(200) }), queued({ body: 'short' })], T0);
    expect(health.segments).toBe(3);
  });
});
