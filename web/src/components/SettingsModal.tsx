import { useState } from 'react';
import type { Project, ProjectSettings } from '../lib/types';

interface Props {
  project: Project;
  setProject(p: Project): void;
  onClose(): void;
  gridSpacingM: number;
  setGridSpacingM(v: number): void;
}

/// Settings modal that buffers edits locally and only commits to the project
/// state when the user presses Done. This stops every input keystroke from
/// kicking off a re-evaluation, which previously froze the modal mid-typing.
export function SettingsModal({ project, setProject, onClose, gridSpacingM, setGridSpacingM }: Props) {
  // Local working copies — updated freely without touching project state.
  const [draft, setDraft] = useState<ProjectSettings | null>(project.settings ?? null);
  const [draftSpacing, setDraftSpacing] = useState(gridSpacingM);

  if (!draft) return null;

  function update(patch: Partial<ProjectSettings>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function commit() {
    setProject({ ...project, settings: draft! });
    if (draftSpacing !== gridSpacingM) setGridSpacingM(draftSpacing);
    onClose();
  }

  function cancel() {
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Project settings</h2>
          <button className="x-btn" onClick={cancel}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <h3>Ground</h3>
            <label className="fld">
              <span>Default ground factor G (0 = hard, 1 = porous)</span>
              <input
                type="number" min={0} max={1} step={0.05}
                value={draft.ground.defaultG}
                onChange={(e) => update({ ground: { ...draft.ground, defaultG: +e.target.value } })}
              />
            </label>
            <div className="hint">Annex D rules cap G at 0.5 for wind turbine sources regardless of this setting.</div>
          </section>

          <section className="settings-section">
            <h3>Annex D — wind turbines</h3>
            <label className="fld">
              <span>Barrier Abar cap (dB)</span>
              <input
                type="number" min={0} max={25} step={0.5}
                value={draft.annexD.barrierAbarCapDb}
                onChange={(e) => update({ annexD: { ...draft.annexD, barrierAbarCapDb: +e.target.value } })}
              />
            </label>
            <label className="fld checkbox">
              <input
                type="checkbox"
                checked={draft.annexD.useElevatedSourceForBarrier}
                onChange={(e) => update({ annexD: { ...draft.annexD, useElevatedSourceForBarrier: e.target.checked } })}
              />
              <span>Use tip height as barrier source (Annex D.3)</span>
            </label>
            <label className="fld checkbox">
              <input
                type="checkbox"
                checked={draft.annexD.applyConcaveCorrection}
                onChange={(e) => update({ annexD: { ...draft.annexD, applyConcaveCorrection: e.target.checked } })}
              />
              <span>Apply concave-ground correction (Annex D.5, −3 dB)</span>
            </label>
            <label className="fld">
              <span>WT receiver minimum height (m)</span>
              <input
                type="number" min={1} max={20} step={0.5}
                value={draft.annexD.wtReceiverHeightMin}
                onChange={(e) => update({ annexD: { ...draft.annexD, wtReceiverHeightMin: +e.target.value } })}
              />
            </label>
          </section>

          <section className="settings-section">
            <h3>General sources</h3>
            <label className="fld">
              <span>Default receiver height (m) for non-WT calcs</span>
              <input
                type="number" min={1} max={5} step={0.1}
                value={draft.general.defaultReceiverHeight}
                onChange={(e) => update({ general: { ...draft.general, defaultReceiverHeight: +e.target.value } })}
              />
            </label>
          </section>

          <section className="settings-section">
            <h3>Contour grid</h3>
            <label className="fld">
              <span>Grid spacing (m)</span>
              <select value={draftSpacing} onChange={(e) => setDraftSpacing(+e.target.value)}>
                <option value={25}>25 m (fine)</option>
                <option value={50}>50 m (default)</option>
                <option value={100}>100 m (coarse)</option>
                <option value={200}>200 m (preview)</option>
              </select>
            </label>
            <div className="hint">Smaller spacing = sharper contours but slower Run.</div>
          </section>

          <section className="settings-section">
            <h3>Drag extrapolation caps</h3>
            <div className="grid-2">
              <label className="fld">
                <span>Per-band cap (dB)</span>
                <input
                  type="number" min={1} max={20} step={0.5}
                  value={draft.extrapolation?.capPerBandDb ?? 6}
                  onChange={(e) => update({
                    extrapolation: { ...(draft.extrapolation ?? { capPerBandDb: 6, capTotalDbA: 3 }), capPerBandDb: +e.target.value },
                  })}
                />
              </label>
              <label className="fld">
                <span>Total dB(A) cap</span>
                <input
                  type="number" min={0.5} max={20} step={0.5}
                  value={draft.extrapolation?.capTotalDbA ?? 3}
                  onChange={(e) => update({
                    extrapolation: { ...(draft.extrapolation ?? { capPerBandDb: 6, capTotalDbA: 3 }), capTotalDbA: +e.target.value },
                  })}
                />
              </label>
            </div>
            <div className="hint">
              When Taylor extrapolation predicts a change larger than these caps the displayed
              value is clamped and an exact re-snapshot is queued.
            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className="btn primary" onClick={commit}>Done</button>
        </div>
      </div>
    </div>
  );
}
