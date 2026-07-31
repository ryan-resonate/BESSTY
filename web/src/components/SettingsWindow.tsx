// I10 — settings as a tabbed floating window.
//
// Non-modal by design: a setting is only judgeable against the map, so the map
// stays interactive while this is open. Settings have moved OUT of the side
// panel entirely; the old tab slot keeps a link here for muscle memory.

import { useState } from 'react';
import { FloatingWindow } from './FloatingWindow';
import {
  SETTINGS_TABS, SettingsTab, type SettingsTabId, type SettingsTabProps,
} from './SidePanel';

export function SettingsWindow(props: SettingsTabProps & { onClose(): void }) {
  const [tab, setTab] = useState<SettingsTabId>('calculation');
  const { onClose, ...rest } = props;
  return (
    <FloatingWindow
      title="Settings"
      onClose={onClose}
      persistKey="settings"
      defaultRect={{ w: 480, h: 640 }}
      minW={360}
      minH={280}
    >
      <div className="seg" style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 10 }}>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>
      <SettingsTab {...rest} tab={tab} />
    </FloatingWindow>
  );
}
