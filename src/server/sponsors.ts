import { query, queryOne } from '@/db/client';
import { recordEvent } from './events';
import { sponsorTasks, totalsFor, type Sponsor, type SponsorGift } from '@/domain/sponsors';
import { toWallClock } from '@/domain/time';

/**
 * Sponsors, loaded with everything they gave.
 *
 * The join is the point. A sponsor's money sits in `revenue_entry`, their goods
 * in `gift_in_kind`, and what those goods fetched in `auction_item` — three
 * tables that until now had no idea they were describing the same relationship.
 * A thank-you letter that can say "your barbecue raised $320" needs all three,
 * and a person assembling that by hand in August will not do it for forty
 * sponsors.
 */

export interface SponsorRow extends Sponsor {
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
}

export async function sponsors(tournamentId: string): Promise<SponsorRow[]> {
  const rows = await query<{
    id: string;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    pamphlet_name: string | null;
    promised: string | null;
    pamphlet_confirmed_at: Date | null;
    thanked_at: Date | null;
    notes: string | null;
  }>(
    `SELECT id, name, contact_name, contact_email, contact_phone, pamphlet_name,
            promised, pamphlet_confirmed_at, thanked_at, notes
       FROM sponsor WHERE tournament_id = $1 ORDER BY lower(name)`,
    [tournamentId],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  // Goods and labour, with what each one fetched if it went under the hammer.
  const gifts = await query<{
    sponsor_id: string;
    kind: 'goods' | 'services';
    what: string;
    fair_market_value_cents: number | null;
    earned_cents: string | null;
  }>(
    `SELECT g.sponsor_id, g.kind, g.what, g.fair_market_value_cents,
            (SELECT b.amount_cents::text
               FROM auction_item i
               JOIN auction_bid b ON b.item_id = i.id AND b.voided_at IS NULL
              WHERE i.gift_id = g.id AND i.status = 'closed'
              ORDER BY b.amount_cents DESC, b.placed_at ASC LIMIT 1) AS earned_cents
       FROM gift_in_kind g
      WHERE g.sponsor_id = ANY($1::uuid[])`,
    [ids],
  );

  const cash = await query<{ sponsor_id: string; description: string; amount_cents: number }>(
    `SELECT sponsor_id, description, amount_cents
       FROM revenue_entry WHERE sponsor_id = ANY($1::uuid[])`,
    [ids],
  );

  const byId = new Map<string, SponsorGift[]>();
  const push = (sponsorId: string, gift: SponsorGift) => {
    const list = byId.get(sponsorId) ?? [];
    list.push(gift);
    byId.set(sponsorId, list);
  };

  for (const row of cash) {
    push(row.sponsor_id, {
      kind: 'cash',
      what: row.description,
      valueCents: row.amount_cents,
      earnedCents: null,
    });
  }
  for (const row of gifts) {
    push(row.sponsor_id, {
      kind: row.kind,
      what: row.what,
      valueCents: row.fair_market_value_cents,
      earnedCents: row.earned_cents === null ? null : Number(row.earned_cents),
    });
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    pamphletName: row.pamphlet_name,
    promised: row.promised,
    pamphletConfirmedAt: row.pamphlet_confirmed_at,
    thankedAt: row.thanked_at,
    notes: row.notes,
    gifts: byId.get(row.id) ?? [],
  }));
}

export async function board(
  tournamentId: string,
  pamphletDeadline: Date | null,
  weekendOver: boolean,
): Promise<{
  sponsors: SponsorRow[];
  tasks: ReturnType<typeof sponsorTasks>;
  totals: { cashCents: number; goodsValueCents: number; earnedCents: number };
}> {
  const all = await sponsors(tournamentId);
  const totals = all.reduce(
    (sum, sponsor) => {
      const own = totalsFor(sponsor);
      return {
        cashCents: sum.cashCents + own.cashCents,
        goodsValueCents: sum.goodsValueCents + own.goodsValueCents,
        earnedCents: sum.earnedCents + own.earnedCents,
      };
    },
    { cashCents: 0, goodsValueCents: 0, earnedCents: 0 },
  );

  return {
    sponsors: all,
    tasks: sponsorTasks(all, pamphletDeadline, toWallClock(new Date()), weekendOver),
    totals,
  };
}

export async function addSponsor(
  tournamentId: string,
  input: { name: string; pamphletName: string; contactName: string; contactEmail: string; promised: string },
  actor: string,
  actorRole: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const name = input.name.trim().slice(0, 160);
  if (name.length < 2) return { ok: false, error: 'no_name' };

  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO sponsor (tournament_id, name, pamphlet_name, contact_name, contact_email, promised)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        tournamentId,
        name,
        input.pamphletName.trim().slice(0, 200) || null,
        input.contactName.trim().slice(0, 160) || null,
        input.contactEmail.trim().toLowerCase().slice(0, 200) || null,
        input.promised.trim().slice(0, 1000) || null,
      ],
    );
    await recordEvent({
      tournamentId,
      actor,
      actorRole,
      kind: 'sponsor.added',
      subjectType: 'sponsor',
      subjectId: row?.id ?? null,
      payload: { name },
    });
    return { ok: true, id: row?.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, error: 'duplicate' };
    throw error;
  }
}

const FIELDS: Record<string, string> = {
  name: 'name',
  pamphlet_name: 'pamphlet_name',
  contact_name: 'contact_name',
  contact_email: 'contact_email',
  contact_phone: 'contact_phone',
  promised: 'promised',
  notes: 'notes',
};

export async function saveSponsorField(
  tournamentId: string,
  id: string,
  field: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  const column = FIELDS[field];
  if (!column) return { ok: false, error: 'unknown field' };

  try {
    await query(
      `UPDATE sponsor SET ${column} = $3, updated_at = now() WHERE id = $1 AND tournament_id = $2`,
      [id, tournamentId, value.trim().slice(0, 1000) || null],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, error: 'That name is taken.' };
    throw error;
  }
  return { ok: true };
}

/**
 * Mark a sponsor's pamphlet entry as sent, or their thank-you as written.
 *
 * Both are toggles rather than one-way stamps, because the person ticking them
 * off a list is doing it from memory and will occasionally tick the wrong row —
 * and an un-tickable box means the only way back is a database.
 */
export async function setSponsorFlag(
  tournamentId: string,
  id: string,
  flag: 'pamphlet' | 'thanked',
  done: boolean,
  actor: string,
  actorRole: string,
): Promise<void> {
  const column = flag === 'pamphlet' ? 'pamphlet_confirmed' : 'thanked';
  await query(
    `UPDATE sponsor
        SET ${column}_at = CASE WHEN $3 THEN now() ELSE NULL END,
            ${column}_by = CASE WHEN $3 THEN $4 ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND tournament_id = $2`,
    [id, tournamentId, done, actor],
  );

  await recordEvent({
    tournamentId,
    actor,
    actorRole,
    kind: 'sponsor.updated',
    subjectType: 'sponsor',
    subjectId: id,
    payload: { flag, done },
  });
}

/** Attach an existing gift or cash entry to a sponsor, so the totals join up. */
export async function linkToSponsor(
  tournamentId: string,
  table: 'gift_in_kind' | 'revenue_entry',
  rowId: string,
  sponsorId: string | null,
): Promise<void> {
  await query(
    `UPDATE ${table} SET sponsor_id = $3 WHERE id = $1 AND tournament_id = $2`,
    [rowId, tournamentId, sponsorId],
  );
}
