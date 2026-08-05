import { StaffBar } from '../_components/StaffBar';

/**
 * The till gets the same bar as HQ.
 *
 * A concession volunteer only ever sees this half of the tool, and before this
 * there was no way for them to sign out of a shared phone at the end of a
 * shift.
 */
export default function PosLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StaffBar />
      {children}
    </>
  );
}
