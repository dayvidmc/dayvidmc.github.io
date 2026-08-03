'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentTournament } from '@/server/repo';
import { addVolunteer } from '@/server/volunteers';

/**
 * Somebody offering to help, from the public page.
 *
 * Reachable by anyone on the internet, so it follows the same habits as the
 * entry form: nothing is decided from the posted form except the person's own
 * details, and an error never repeats back what somebody typed.
 *
 * It creates an ordinary volunteer row. The coordinator sees them in her list
 * exactly as if she had typed them in — which is the point. Staffing is "a mix,
 * and a struggle every year", and a parent who offers an hour on a Tuesday
 * evening should not have to find her email address to do it.
 */
function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function offerToHelpAction(formData: FormData): Promise<void> {
  const tournament = await currentTournament();
  if (!tournament) redirect('/volunteer?error=closed');

  const name = text(formData, 'name').trim();
  if (name.length < 2) redirect('/volunteer?error=no_name');

  // A phone or an email. Without one of the two there is no way to ring them
  // back, and a row nobody can contact is a row that looks like help and isn't.
  const phone = text(formData, 'phone').trim();
  const email = text(formData, 'email').trim();
  if (!phone && !email) redirect('/volunteer?error=no_contact');

  const result = await addVolunteer(
    tournament!.id,
    {
      name,
      phone,
      email,
      canDo: [text(formData, 'canDo'), text(formData, 'when')]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' · '),
      notes: text(formData, 'notes'),
    },
    name,
    'public',
  );

  // Somebody already on the list who fills the form in again has not done
  // anything wrong, and telling them "you are already on a list" is a strange
  // thing to say to a volunteer. They get the same thank-you.
  if (!result.ok && result.error !== 'duplicate') {
    redirect(`/volunteer?error=${result.error}`);
  }

  revalidatePath('/hq/volunteers/people');
  redirect('/volunteer?thanks=1');
}
