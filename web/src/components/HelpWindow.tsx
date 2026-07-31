// I11 — help in a floating window, so you can read it while working rather
// than navigating away from the project.

import { FloatingWindow } from './FloatingWindow';
import { HelpContent } from './HelpContent';

export function HelpWindow({ onClose }: { onClose(): void }) {
  return (
    <FloatingWindow
      title="Help"
      onClose={onClose}
      persistKey="help"
      defaultRect={{ w: 720, h: 560, x: 80 }}
      minW={480}
      minH={320}
    >
      <div style={{ height: '100%', minHeight: 0 }}>
        <HelpContent compact />
      </div>
    </FloatingWindow>
  );
}
