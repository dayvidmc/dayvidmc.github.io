import { currentStaff } from '@/server/auth';
import { ROLE_LABEL, sectionsFor } from '@/domain/navigation';
import { signOut } from '../hq/actions';

/**
 * The bar across every staff screen.
 *
 * Three problems it exists to solve, all found by walking the whole tool as
 * each role at every screen size.
 *
 * **Signing out was only possible on the board.** A concession volunteer or a
 * coordinator, neither of whom can open the board, had no way to sign out at
 * all — on a phone that gets passed between shifts.
 *
 * **Navigation lived on the board too.** Sixteen identical grey buttons sat
 * above the games on the single screen the director needs to read fastest, and
 * every other screen had only a link back to its own parent. Getting from the
 * cash screen to the umpires meant two taps backwards and one forwards.
 *
 * **It offered the same sixteen to everybody.** A volunteer coordinator does
 * not need to be shown a rules editor she will be redirected away from.
 *
 * It is a `<details>` element for the same reason the public menu is (§2.54):
 * it opens with no JavaScript, on any phone, on any connection. It carries no
 * "you are here" marker deliberately — that would need the pathname, which in
 * a server layout means either middleware or a client bundle, and the page's
 * own heading already says where you are.
 */
export async function StaffBar() {
  const staff = await currentStaff();
  if (!staff) return null;

  const sections = sectionsFor(staff.role);
  // One screen to their name means a menu would be a control that does
  // nothing. The till volunteer gets their name and a way out, no more.
  const single = sections.length === 1 && sections[0]!.items.length === 1;

  return (
    <div className="staff-bar">
      <div className="staff-who">
        <span>
          <strong>{staff.name}</strong>
          <span className="meta"> · {ROLE_LABEL[staff.role]}</span>
        </span>
        <form action={signOut}>
          <button type="submit" className="staff-signout">
            Sign out
          </button>
        </form>
      </div>

      {!single && (
        <details className="menu staff-menu">
          <summary>Go to</summary>
          <div className="menu-panel">
            {sections.map((section) => (
              <section key={section.title}>
                <h2>{section.title}</h2>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <a href={item.href}>
                        {item.label}
                        {item.hint && <small>{item.hint}</small>}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <section>
              <h2>The public site</h2>
              <ul>
                <li>
                  <a href="/">What everybody else sees</a>
                </li>
              </ul>
            </section>
          </div>
        </details>
      )}
    </div>
  );
}
