import { notFound, redirect } from 'next/navigation';
import { canAccessHq, currentStaff, isDirector } from '@/server/auth';
import { currentTournament } from '@/server/repo';
import { allPages, NAV_GROUP_LABEL, NAV_GROUP_ORDER } from '@/server/site';
import { AutoSaveField, AutoSaveSelect } from '../../../_components/AutoSave';
import { Prose } from '../../../_components/Prose';
import { deletePageAction, savePageField, setPublishedAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Editing one page.
 *
 * The preview underneath the box is the whole design. Markdown is a small ask
 * of somebody who has never met it, and the honest way to teach it is to show
 * what their words look like as they type them rather than to explain a syntax
 * and hope.
 *
 * Publishing is a button, not an auto-saving toggle. Everything else on this
 * screen saves as you go, because losing a paragraph to a closed tab is worse
 * than any accidental save — but putting words on a public website is a
 * decision, and a decision gets a button.
 */
export default async function EditPageScreen({
  params,
  searchParams,
}: {
  params: Promise<{ pageId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const staff = await currentStaff();
  if (!canAccessHq(staff)) redirect('/signin');

  const tournament = await currentTournament();
  if (!tournament) return <div className="notice info">No tournament set up yet.</div>;

  const { pageId } = await params;
  const search = await searchParams;

  const page = (await allPages(tournament.id)).find((row) => row.id === pageId);
  if (!page) notFound();

  const editable = isDirector(staff);
  const save = savePageField.bind(null, page.id);

  return (
    <>
      <h1>{page.title}</h1>
      <p className="sub">
        /p/{page.slug} · {page.published ? 'live on the public site' : 'a draft, visible only here'}
      </p>

      <div className="subnav">
        <a className="btn back" href="/hq/site">← All pages</a>
        {page.published && (
          <a className="btn" href={`/p/${page.slug}`}>
            See it live
          </a>
        )}
      </div>

      {search.saved && <div className="notice ok">Saved.</div>}

      <fieldset disabled={!editable}>
        <legend>What it says</legend>
        <AutoSaveField save={save} field="title" label="Title" defaultValue={page.title} />
        <AutoSaveField
          save={save} field="summary" label="One line underneath"
          defaultValue={page.summary ?? ''}
          hint="Optional, and usually the most-read words on the page."
        />

        <AutoSaveField
          save={save} field="body" label="The page itself" labelHidden
          defaultValue={page.body} multiline
          hint="A blank line starts a paragraph. # for a heading, - for a list, **bold**, *italic*, [words](https://a-link). Anything else appears exactly as you type it."
        />
      </fieldset>

      <h2>How it looks</h2>
      {page.body.trim() === '' ? (
        <div className="empty">Nothing written yet.</div>
      ) : (
        <div className="card">
          <Prose source={page.body} />
        </div>
      )}
      <p className="hint">
        The preview updates when the box saves. Links to somewhere unexpected — anything that is
        not a web address, an email address or a page on this site — appear as plain words rather
        than links, on purpose.
      </p>

      <fieldset disabled={!editable}>
        <legend>Where it sits</legend>
        <AutoSaveSelect
          save={save}
          field="navGroup"
          label="Section of the menu"
          defaultValue={page.navGroup ?? ''}
          options={[
            { value: '', label: 'Not in the menu — reachable by link only' },
            ...NAV_GROUP_ORDER.map((group) => ({ value: group, label: NAV_GROUP_LABEL[group] })),
          ]}
          hint="Which heading this appears under. The schedule, standings and playoffs are always in the menu whatever is set here — they cannot be removed by editing a page."
        />
        <AutoSaveField
          save={save} field="navLabel" label="Menu wording"
          defaultValue={page.navLabel ?? ''}
          hint="Optional. The title is used when this is blank — worth setting when the title is long."
        />
        <AutoSaveField
          save={save} field="navOrder" label="Order in the section" type="number"
          defaultValue={String(page.navOrder)}
          hint="Lower comes first. Everything defaults to 100, so a page you want at the top can be 10."
        />
      </fieldset>

      {editable && (
        <>
          <h2>{page.published ? 'Take it down' : 'Publish it'}</h2>
          <form action={setPublishedAction} className="card">
            <input type="hidden" name="id" value={page.id} />
            <input type="hidden" name="published" value={page.published ? '0' : '1'} />
            <p className="hint" style={{ marginTop: 0 }}>
              {page.published
                ? 'Taking it down leaves the words here and removes the page from the public site and the menu.'
                : 'Publishing puts this page on the public site and, if it has a section, into the menu.'}
            </p>
            <button type="submit" className={page.published ? 'wide' : 'primary wide'} style={{ minHeight: 48 }}>
              {page.published ? 'Take it down' : 'Publish it'}
            </button>
          </form>

          <form action={deletePageAction} style={{ marginTop: 24 }}>
            <input type="hidden" name="id" value={page.id} />
            <button type="submit" style={{ minHeight: 44, fontSize: 14 }}>
              Delete this page for good
            </button>
          </form>
        </>
      )}
    </>
  );
}
