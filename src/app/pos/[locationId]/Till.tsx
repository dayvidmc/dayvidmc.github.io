'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addItem,
  amountDue,
  cartCount,
  cartSubtotal,
  cashRoundingAdjustment,
  changeDue,
  formatMoney,
  isMarkedDown,
  sellingPrice,
  parseMoney,
  quickCashOptions,
  setQuantity,
  type CartLine,
  type MenuItem,
} from '@/domain/pos';

/**
 * The till.
 *
 * Written for a volunteer standing at a folding table with a queue in front of
 * them, so the whole thing is thumb-reachable and nothing needs a second tap to
 * confirm what a first tap did.
 *
 * **Offline is the point.** Sales are held in local storage the moment they are
 * completed and uploaded whenever there is signal. This is safe without any
 * conflict resolution because a sale is an immutable event, not shared mutable
 * state: two tills can never disagree about an order, because no two tills ever
 * touch the same one. The order id is generated here, before the sale finishes,
 * and doubles as the idempotency key — so a retry after a timeout cannot
 * double-count the day's takings.
 */

const QUEUE_KEY = 'tokessy_pos_queue_v1';
const SYNC_INTERVAL_MS = 15_000;

interface QueuedOrder {
  id: string;
  locationId: string;
  registerSessionId: string | null;
  soldBy: string;
  deviceLabel: string | null;
  soldAt: string;
  subtotalCents: number;
  totalCents: number;
  roundingCents: number;
  lines: {
    itemId: string | null;
    name: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }[];
  tenders: {
    kind: 'cash' | 'card' | 'ticket' | 'other';
    amountCents: number;
    tenderedCents: number | null;
    changeCents: number | null;
    ticketCount: number | null;
    squarePaymentId: string | null;
    squareStatus: string | null;
  }[];
}

type Mode = 'sell' | 'cash' | 'card' | 'ticket' | 'done';

function readQueue(): QueuedOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedOrder[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(orders: QueuedOrder[]) {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(orders));
  } catch {
    // Storage full or blocked. The caller keeps the order in memory; the worst
    // case is losing unsynced sales if the tab is closed, which is why the
    // banner below never claims everything is safe when the queue is non-empty.
  }
}

export function Till({
  locationId,
  locationName,
  menu,
  soldBy,
  registerSessionId,
  deviceLabel,
  squareApplicationId,
  ticketCovers,
}: {
  locationId: string;
  locationName: string;
  menu: MenuItem[];
  soldBy: string;
  registerSessionId: string | null;
  deviceLabel: string | null;
  squareApplicationId: string | null;
  /** What one ticket is good for, in the words the committee uses. */
  ticketCovers: string | null;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [mode, setMode] = useState<Mode>('sell');
  const [cartOpen, setCartOpen] = useState(false);
  const [tenderedInput, setTenderedInput] = useState('');
  const [ticketCount, setTicketCount] = useState(1);
  const [lastChange, setLastChange] = useState<number | null>(null);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncing = useRef(false);

  const subtotal = cartSubtotal(lines);
  const cashTotal = amountDue(subtotal, 'cash');
  const cardTotal = amountDue(subtotal, 'card');

  useEffect(() => {
    setQueued(readQueue().length);
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const sync = useCallback(async () => {
    if (syncing.current) return;
    const pending = readQueue();
    if (pending.length === 0) {
      setQueued(0);
      return;
    }

    syncing.current = true;
    try {
      const response = await fetch('/api/pos/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orders: pending.slice(0, 100) }),
      });

      if (!response.ok) throw new Error(`server said ${response.status}`);
      const result = (await response.json()) as {
        stored: string[];
        rejected: { id: string; reason: string }[];
      };

      // Clear only what the server confirmed it has. Anything unmentioned stays
      // queued and is retried — never dropped on the assumption it worked.
      const stored = new Set(result.stored);
      const remaining = readQueue().filter((order) => !stored.has(order.id));
      writeQueue(remaining);
      setQueued(remaining.length);

      setSyncError(
        result.rejected.length > 0
          ? `${result.rejected.length} sale(s) were refused by the server. Tell the concession lead.`
          : null,
      );
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'could not reach the server');
    } finally {
      syncing.current = false;
    }
  }, []);

  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sync]);

  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  const complete = useCallback(
    (tender: QueuedOrder['tenders'][number], totalCents: number, roundingCents: number) => {
      const order: QueuedOrder = {
        // crypto.randomUUID needs a secure context; fall back so a till served
        // over plain HTTP on a laptop at the park still works.
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : fallbackUuid(),
        locationId,
        registerSessionId,
        soldBy,
        deviceLabel,
        soldAt: new Date().toISOString(),
        subtotalCents: subtotal,
        totalCents,
        roundingCents,
        lines: lines.map((line) => ({
          itemId: line.itemId,
          name: line.name,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          lineTotalCents: line.unitPriceCents * line.quantity,
        })),
        tenders: [tender],
      };

      const next = [...readQueue(), order];
      writeQueue(next);
      setQueued(next.length);
      void sync();

      setLines([]);
      setTenderedInput('');
      setTicketCount(1);
      setCartOpen(false);
      setMode('done');
    },
    [lines, locationId, registerSessionId, soldBy, deviceLabel, subtotal, sync],
  );

  const tendered = parseMoney(tenderedInput);
  const change = tendered === null ? null : changeDue(cashTotal, tendered);
  const rounding = cashRoundingAdjustment(subtotal);

  const categories = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const item of menu) {
      const key = item.category ?? 'Other';
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()];
  }, [menu]);

  // --- Done -----------------------------------------------------------------

  if (mode === 'done') {
    return (
      <div className="till-done">
        <p className="till-done-label">Sale complete</p>
        {lastChange !== null && lastChange > 0 ? (
          <>
            <p className="till-done-label">Change</p>
            <p className="till-change">{formatMoney(lastChange)}</p>
          </>
        ) : (
          <p className="till-change">✓</p>
        )}
        <button
          className="primary wide till-big"
          onClick={() => {
            setLastChange(null);
            setMode('sell');
          }}
        >
          Next sale
        </button>
      </div>
    );
  }

  // --- Cash -----------------------------------------------------------------

  if (mode === 'cash') {
    return (
      <div>
        <SyncBanner online={online} queued={queued} error={syncError} />
        <div className="till-total-row">
          <span>Due</span>
          <strong>{formatMoney(cashTotal)}</strong>
        </div>
        {rounding !== 0 && (
          <p className="hint" style={{ marginTop: 0 }}>
            Rounded {rounding > 0 ? 'up' : 'down'} {formatMoney(Math.abs(rounding))} to the nearest
            nickel. Card would be {formatMoney(cardTotal)}.
          </p>
        )}

        <div className="quick-cash">
          {quickCashOptions(cashTotal).map((option) => (
            <button key={option} onClick={() => setTenderedInput((option / 100).toFixed(2))}>
              {formatMoney(option)}
            </button>
          ))}
        </div>

        <label htmlFor="tendered">Cash received</label>
        <input
          id="tendered"
          type="text"
          inputMode="decimal"
          value={tenderedInput}
          onChange={(e) => setTenderedInput(e.target.value)}
          placeholder="0.00"
          autoFocus
          style={{ fontSize: 32, textAlign: 'right', minHeight: 64 }}
        />

        {tendered !== null && change !== null && (
          <div className="till-total-row change">
            <span>Change</span>
            <strong>{formatMoney(change)}</strong>
          </div>
        )}
        {tendered !== null && change === null && (
          <div className="notice warn">That is less than the amount due.</div>
        )}

        <button
          className="primary wide till-big"
          disabled={change === null}
          onClick={() => {
            if (change === null || tendered === null) return;
            setLastChange(change);
            complete(
              {
                kind: 'cash',
                amountCents: cashTotal,
                tenderedCents: tendered,
                changeCents: change,
                ticketCount: null,
                squarePaymentId: null,
                squareStatus: null,
              },
              cashTotal,
              rounding,
            );
          }}
        >
          Take {formatMoney(cashTotal)} cash
        </button>
        <button className="wide" onClick={() => setMode('sell')} style={{ marginTop: 10 }}>
          Back
        </button>
      </div>
    );
  }

  // --- Card -----------------------------------------------------------------

  if (mode === 'card') {
    return (
      <div>
        <SyncBanner online={online} queued={queued} error={syncError} />
        <div className="till-total-row">
          <span>Due</span>
          <strong>{formatMoney(cardTotal)}</strong>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Card is charged to the exact cent — no nickel rounding.
        </p>

        {/*
          Tapping a card on this phone needs a native app: Apple and Google only
          expose the NFC reader to signed native apps, so no browser can do it.
          The Square app can, which is why this hands off rather than pretending.
        */}
        {squareApplicationId ? (
          <a
            className="btn primary wide till-big"
            href={squarePosLink(squareApplicationId, cardTotal)}
            onClick={() => setTimeout(() => window.focus(), 0)}
          >
            Open Square to take the card
          </a>
        ) : (
          <div className="notice info">
            No Square application id configured, so the handoff button is hidden. Take the payment in
            the Square app as usual, then confirm below.
          </div>
        )}

        <div className="notice warn">
          Confirm only once Square shows the payment as approved. This records the sale here; it does
          not charge anything.
        </div>

        <button
          className="primary wide till-big"
          onClick={() =>
            complete(
              {
                kind: 'card',
                amountCents: cardTotal,
                tenderedCents: null,
                changeCents: null,
                ticketCount: null,
                squarePaymentId: null,
                squareStatus: 'confirmed_by_volunteer',
              },
              cardTotal,
              0,
            )
          }
        >
          Card approved — record {formatMoney(cardTotal)}
        </button>
        <button className="wide" onClick={() => setMode('sell')} style={{ marginTop: 10 }}>
          Back
        </button>
      </div>
    );
  }

  // --- Tickets ----------------------------------------------------------------

  if (mode === 'ticket') {
    return (
      <div>
        <SyncBanner online={online} queued={queued} error={syncError} />
        <div className="till-total-row">
          <span>Worth</span>
          <strong>{formatMoney(cardTotal)}</strong>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          No money changes hands. The food is still recorded at what it would have sold for, so the
          stock adds up at the end of the day and the raised figure does not count food that was
          given away.
        </p>

        {ticketCovers && <div className="notice info">One ticket covers {ticketCovers}.</div>}

        <label htmlFor="ticketCount">How many tickets</label>
        <div className="quick-cash">
          {[1, 2, 3, 4].map((count) => (
            <button
              key={count}
              onClick={() => setTicketCount(count)}
              style={count === ticketCount ? { fontWeight: 700, outline: '2px solid currentColor' } : undefined}
            >
              {count}
            </button>
          ))}
        </div>
        <input
          id="ticketCount"
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          value={ticketCount}
          onChange={(e) => setTicketCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          style={{ fontSize: 32, textAlign: 'right', minHeight: 64 }}
        />

        <button
          className="primary wide till-big"
          onClick={() =>
            complete(
              {
                kind: 'ticket',
                amountCents: cardTotal,
                tenderedCents: null,
                changeCents: null,
                ticketCount,
                squarePaymentId: null,
                squareStatus: null,
              },
              cardTotal,
              0,
            )
          }
        >
          Take {ticketCount} ticket{ticketCount === 1 ? '' : 's'}
        </button>
        <button className="wide" onClick={() => setMode('sell')} style={{ marginTop: 10 }}>
          Back
        </button>
      </div>
    );
  }

  // --- Selling --------------------------------------------------------------

  return (
    <div className="till">
      <SyncBanner online={online} queued={queued} error={syncError} />

      <div className="till-header">
        <strong>{locationName}</strong>
        <span className="meta">{soldBy}</span>
      </div>

      {menu.length === 0 && (
        <div className="empty">
          Nothing on the menu yet. A concession lead can add items from{' '}
          <a href="/hq/concessions">the menu screen</a>.
        </div>
      )}

      {categories.map(([category, items]) => (
        <section key={category}>
          <h2 className="till-category">{category}</h2>
          <div className="item-grid">
            {items.map((item) => (
              <button
                key={item.id}
                className="item-button"
                style={item.colour ? { borderColor: item.colour } : undefined}
                onClick={() => setLines((current) => addItem(current, item))}
              >
                <span className="item-name">{item.name}</span>
                {/* A marked-down button has to show both numbers. A price that
                    changed without the customer being able to see why is a
                    conversation the volunteer cannot win. */}
                {isMarkedDown(item) ? (
                  <span className="item-price">
                    <s style={{ opacity: 0.6 }}>{formatMoney(item.priceCents)}</s>{' '}
                    {formatMoney(sellingPrice(item))}
                  </span>
                ) : (
                  <span className="item-price">{formatMoney(item.priceCents)}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}

      {cartOpen && lines.length > 0 && (
        <div className="cart-list">
          {lines.map((line, index) => (
            <div key={`${line.itemId}-${index}`} className="cart-line">
              <div>
                <div style={{ fontWeight: 600 }}>{line.name}</div>
                <div className="meta">{formatMoney(line.unitPriceCents)} each</div>
              </div>
              <div className="qty">
                <button onClick={() => setLines((c) => setQuantity(c, index, line.quantity - 1))}>
                  −
                </button>
                <span>{line.quantity}</span>
                <button onClick={() => setLines((c) => setQuantity(c, index, line.quantity + 1))}>
                  +
                </button>
              </div>
              <strong style={{ minWidth: 72, textAlign: 'right' }}>
                {formatMoney(line.unitPriceCents * line.quantity)}
              </strong>
            </div>
          ))}
          <button className="wide" onClick={() => setLines([])} style={{ marginTop: 10 }}>
            Clear the cart
          </button>
        </div>
      )}

      {lines.length > 0 && (
        <div className="till-bar">
          <button className="till-bar-summary" onClick={() => setCartOpen((open) => !open)}>
            {cartCount(lines)} item{cartCount(lines) === 1 ? '' : 's'} · {formatMoney(subtotal)}
            <span className="meta"> {cartOpen ? 'hide' : 'view'}</span>
          </button>
          <div className="till-bar-actions">
            <button className="primary" onClick={() => setMode('cash')}>
              Cash {formatMoney(cashTotal)}
            </button>
            <button onClick={() => setMode('card')}>Card {formatMoney(cardTotal)}</button>
            {/* Third, not hidden behind a menu. A queue of ten with three
                ticket-holders in it is a normal Saturday, and a volunteer who
                cannot find this button rings it as cash. */}
            <button onClick={() => setMode('ticket')}>Ticket</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SyncBanner({
  online,
  queued,
  error,
}: {
  online: boolean;
  queued: number;
  error: string | null;
}) {
  if (online && queued === 0 && !error) return null;

  return (
    <div className={`notice ${online && !error ? 'info' : 'warn'}`}>
      {!online && <strong>No signal. </strong>}
      {queued > 0
        ? `${queued} sale${queued === 1 ? '' : 's'} saved on this device, waiting to upload. Keep selling — don't close this tab.`
        : error
          ? `Couldn't reach the server: ${error}`
          : 'Back online.'}
    </div>
  );
}

/**
 * Square Point of Sale deep link.
 *
 * Opens the Square app to take a card on an existing reader or, on a supported
 * phone, by tapping the card against the screen. Needs a Square developer
 * application id.
 *
 * NOT YET VERIFIED ON A REAL DEVICE. The parameters below follow Square's
 * documented Point of Sale API, but nobody has run this against a real Square
 * account and a real reader. Test it before the weekend, and keep the manual
 * confirm button either way — it is the fallback if the handoff misbehaves.
 */
function squarePosLink(applicationId: string, amountCents: number): string {
  const data = {
    amount_money: { amount: amountCents, currency_code: 'CAD' },
    callback_url: typeof window === 'undefined' ? '' : window.location.href,
    client_id: applicationId,
    version: '1.3',
    notes: 'Tokessy tournament concessions',
    options: { supported_tender_types: ['CREDIT_CARD', 'CARD_ON_FILE'] },
  };
  return `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`;
}

/** RFC 4122 v4 shape, for when `crypto.randomUUID` is unavailable. */
function fallbackUuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.floor(Math.random() * 4) + 8)];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}
