import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { currentTournament } from '@/server/repo';
import { pageBySlug } from '@/server/site';
import { firstParagraph } from '@/domain/prose';
import { Prose } from '../../_components/Prose';

export const dynamic = 'force-dynamic';

/**
 * Any page the committee has written.
 *
 * Scott's story, the rules, hotel information, what to do in Kanata on a wet
 * Saturday — all of it is a row rather than a file, so correcting a date does
 * not need a developer.
 *
 * An unpublished page is a 404 here and editable in HQ, which is what lets
 * somebody write next year's information in February without it appearing.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const tournament = await currentTournament();
  if (!tournament) return {};

  const { slug } = await params;
  const page = await pageBySlug(tournament.id, slug);
  if (!page) return {};

  return {
    title: `${page.title} — ${tournament.name}`,
    description: page.summary ?? firstParagraph(page.body),
  };
}

export default async function ContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const tournament = await currentTournament();
  if (!tournament) notFound();

  const { slug } = await params;
  const page = await pageBySlug(tournament.id, slug);
  if (!page) notFound();

  return (
    <>
      <h1>{page.title}</h1>
      {page.summary && <p className="sub">{page.summary}</p>}
      <Prose source={page.body} />
    </>
  );
}
