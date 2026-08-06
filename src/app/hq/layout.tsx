import { StaffBar } from '../_components/StaffBar';

/**
 * The shell every HQ screen sits in.
 *
 * `StaffBar` emits two things — a bar across the top and a navigation column —
 * and this grid places them: the bar spanning the width, the column beside the
 * page on a wide screen, and both stacked on a phone where the column is
 * hidden and the bar's own menu takes over.
 *
 * No guard here. The pages guard themselves and their guards differ — a
 * coordinator may open the volunteers screen and nothing else under `/hq` — so
 * a layout that redirected would have to duplicate every one of them, and the
 * duplicate is what would rot.
 */
export default function HqLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="staff-shell">
      <StaffBar />
      <div className="staff-page">{children}</div>
    </div>
  );
}
