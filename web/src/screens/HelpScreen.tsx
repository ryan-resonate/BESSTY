// User guide, full-page at /help. Reachable by ctrl/middle-clicking the header
// `?` (a plain left-click opens the floating window instead, so you don't lose
// your project).
//
// I11: the content itself lives in `src/help/*.md` and renders through the SAME
// `HelpContent` component the floating window uses. Two copies of the guide
// would diverge the first time someone updated one of them.

import { Link } from 'react-router-dom';
import { HelpContent } from '../components/HelpContent';

export function HelpScreen() {
  return (
    <div className="help-screen" style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>BESSTY user guide</h1>
      <p className="hint" style={{ marginTop: -6 }}>
        Tip: the <b>?</b> button opens this in a floating window so you can read
        it without leaving your project.
      </p>
      <HelpContent />
      <p style={{ marginTop: 32 }}>
        <Link to="/projects">← Back to projects</Link>
      </p>
    </div>
  );
}
