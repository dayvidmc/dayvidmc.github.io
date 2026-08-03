const ROLE_LABEL: Record<string, string> = {
  director: 'tournament director',
  hq: 'HQ',
  volunteer_coordinator: 'volunteer coordinator',
  auction_lead: 'auction lead',
  concession_lead: 'concession lead',
  concession_volunteer: 'concession volunteer',
};

/**
 * Shown when someone is signed in but this screen is not theirs.
 *
 * Deliberately not a redirect to the sign-in page. Bouncing a signed-in
 * volunteer to a login form tells them they are logged out, which is both wrong
 * and the sort of thing that ends with someone hunting for a second PIN.
 */
export function NoAccess({
  role,
  name,
  needs,
  back = '/',
}: {
  role: string;
  name: string;
  needs: string;
  back?: string;
}) {
  return (
    <>
      <h1>Not your screen</h1>
      <div className="notice warn">
        You&apos;re signed in as {name} ({ROLE_LABEL[role] ?? role}). This screen is for {needs}.
      </div>
      <a className="btn wide" href={back}>
        ← Back
      </a>
    </>
  );
}
