import { StaffBar } from '../_components/StaffBar';

/**
 * Every HQ screen gets the staff bar. Nothing else — the page below decides
 * its own guard, because the guards differ (a coordinator may open the
 * volunteers screen and nothing else under `/hq`), and a layout that redirected
 * would have to duplicate every one of them.
 */
export default function HqLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StaffBar />
      {children}
    </>
  );
}
