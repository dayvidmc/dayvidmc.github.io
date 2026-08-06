import { currentStaff } from '@/server/auth';
import { ROLE_LABEL, currentItem, sectionsFor, type NavSection } from '@/domain/navigation';
import { currentPath } from '@/server/pathname';
import { signOut } from '../hq/actions';

/**
 * The tool's own navigation, in two shapes for two kinds of user.
 *
 * The weekend is run from phones, so that shape was built first and is right:
 * one control, opening a list, taking no room until it is wanted.
 *
 * On a desktop it was badly wrong, and the same list is the reason. Thirty
 * destinations in a 320px dropdown that scrolls inside itself and covers the
 * page behind it — on a 1440px screen with six hundred pixels of empty margin
 * either side. Everything a mouse and a large screen are good at, that shape
 * gives up: seeing the whole structure at once, knowing where you are in it,
 * and moving between two places in one click instead of three.
 *
 * So on a wide screen the same sections become a column that is simply always
 * there, and the dropdown is hidden. One list either way — `sectionsFor()`
 * still decides what a role may see, and the test that holds it against the
 * guards still applies to both.
 *
 * Which one is shown is CSS, not JavaScript. Both are in the markup, one is
 * `display: none` at a breakpoint. A layout that had to measure the window
 * before it could render its own navigation would flicker on every page load
 * and break entirely without JavaScript.
 */
export async function StaffBar() {
  const staff = await currentStaff();
  if (!staff) return null;

  const sections = sectionsFor(staff.role);
  const path = await currentPath();
  const here = currentItem(staff.role, path);
  // One screen to their name means a menu would be a control that does nothing.
  const single = sections.length === 1 && sections[0]!.items.length === 1;

  return (
    <>
      {/* The bar, at every width: who you are, and the way out. */}
      <div className="staff-bar">
        <div className="staff-who">
          <a href={sections[0]?.items[0]?.href ?? '/'} className="staff-home">
            Tokessy<span className="long"> HQ</span>
          </a>
          <span className="staff-name">
            <strong>{staff.name}</strong>
            <span className="meta"> · {ROLE_LABEL[staff.role]}</span>
          </span>
        </div>

        <div className="staff-actions">
          <a className="staff-public" href="/">
            The public site
          </a>
          <form action={signOut}>
            <button type="submit" className="staff-signout">
              Sign out
            </button>
          </form>
        </div>

        {/* The phone shape. Hidden once the sidebar appears. */}
        {!single && (
          <details className="menu staff-menu">
            <summary>{here ? here.label : 'Go to'}</summary>
            <div className="menu-panel">
              <Sections sections={sections} here={here?.href} />
            </div>
          </details>
        )}
      </div>

      {/* The desktop shape. Hidden on a phone. */}
      {!single && (
        <nav className="staff-side" aria-label="Where you can go">
          <Sections sections={sections} here={here?.href} />
        </nav>
      )}
    </>
  );
}

function Sections({ sections, here }: { sections: NavSection[]; here: string | undefined }) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.items.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  // Both, deliberately. `aria-current` is what a screen reader
                  // announces; the class is what an eye sees. Neither
                  // substitutes for the other.
                  aria-current={item.href === here ? 'page' : undefined}
                  className={item.href === here ? 'here' : undefined}
                >
                  {item.label}
                  {item.hint && <small>{item.hint}</small>}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
