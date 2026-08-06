import { StaffBar } from '../_components/StaffBar';

/**
 * The till, in the same shell as HQ.
 *
 * A concession volunteer only ever sees this half of the tool, and for them
 * the navigation column is a single item, so `StaffBar` renders no menu at all
 * — just their name and the way out. A lead signing in on a laptop at the main
 * stand gets the same column as anywhere else.
 */
export default function PosLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="staff-shell">
      <StaffBar />
      <div className="staff-page">{children}</div>
    </div>
  );
}
