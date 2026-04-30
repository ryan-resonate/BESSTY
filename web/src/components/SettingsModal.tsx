import { useState } from 'react';
import type { Project, ProjectSettings } from '../lib/types';
import { ModalBackdrop } from './ModalBackdrop';

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
  const [draftBandSystem, setDraftBandSystem] = useState(project.scenario.bandSystem);
  const [draftSpacing, setDraftSpacing] = useState(gridSpacingM);

  if (!draft) return null;

  function update(patch: Partial<ProjectSettings>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function commit() {
    setProject({
      ...project,
      settings: draft!,
      scenario: { ...project.scenario, bandSystem: draftBandSystem },
    });
    if (draftSpacing !== gridSpacingM) setGridSpacingM(draftSpacing);
    onClose();
  }

  function cancel() {
    onClose();
  }

  return (
    <ModalBackdrop onClose={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Project settings</h2>
          <button className="x-btn" onClick={cancel}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <h3>Band system</h3>
            <label className="fld">
              <span>Solve in</span>
              <select
                value={draftBandSystem}
                onChange={(e) => setDraftBandSystem(e.target.value as 'octave' | 'oneThirdOctave')}
              >
                <option value="octave">Octave (10 bands · 16 Hz – 8 kHz)</option>
                <option value="oneThirdOctave">One-third octave (31 bands · 10 Hz – 10 kHz)</option>
              </select>
            </label>
            <div className="hint">
              Octave is faster; one-third octave catches narrowband content. Source data
              in the other band system is folded automatically (third → octave by energy
              sum; octave → third by equal distribution across the three children).
            </div>
          </section>

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
            <h3>Solid-angle correction (DΩ)</h3>
            <label className="fld">
              <span>DΩ (dB)</span>
              <select
                value={(draft.dOmegaDb ?? 0).toString()}
                onChange={(e) => update({ dOmegaDb: +e.target.value })}
              >
                <option value="0">0 dB — strict ISO 9613-2 / IEC 61400-11 (default)</option>
                <option value="3">+3 dB — hemispherical / common practice (CONCAWE, AS 4959 etc.)</option>
              </select>
            </label>
            <div className="hint">
              Frequency-independent correction added to every band per ISO 9613-2 Eq (1)
              <code> Lp = Lw + DΩ + Dc − A</code>.
              <br />
              <b>0 dB</b> matches strict ISO 9613-2: WTG LwA per IEC 61400-11 already encodes the
              hemispherical reflection, so DΩ is 0.
              <br />
              <b>+3 dB</b> matches common-practice tools that double-count the ground reflection
              by adding the +3 dB anyway. If your reference tool sits about 3 dB above BESSTY,
              switch to this.
            </div>
          </section>

          <section className="settings-section">
            <h3>Atmosphere (ISO 9613-1 Aatm)</h3>
            <div className="grid-2">
              <label className="fld">
                <span>Temperature (°C)</span>
                <input
                  type="number" min={-30} max={50} step={1}
                  value={draft.atmosphere?.temperatureC ?? 10}
                  onChange={(e) => update({
                    atmosphere: {
                      temperatureC: +e.target.value,
                      relativeHumidityPct: draft.atmosphere?.relativeHumidityPct ?? 70,
                      pressureKpa: draft.atmosphere?.pressureKpa ?? 101.325,
                    },
                  })}
                />
              </label>
              <label className="fld">
                <span>Relative humidity (%)</span>
                <input
                  type="number" min={1} max={100} step={1}
                  value={draft.atmosphere?.relativeHumidityPct ?? 70}
                  onChange={(e) => update({
                    atmosphere: {
                      temperatureC: draft.atmosphere?.temperatureC ?? 10,
                      relativeHumidityPct: +e.target.value,
                      pressureKpa: draft.atmosphere?.pressureKpa ?? 101.325,
                    },
                  })}
                />
              </label>
            </div>
            <div className="hint">
              Drives the atmospheric absorption coefficient α(f) per ISO 9613-1
              (closed-form, evaluated inside the WASM solver). The default
              (10 °C / 70 % RH) is the ISO 9613-2 reference. Bumping the
              temperature or dropping the humidity tends to increase mid-band α
              at typical wind-farm distances (1–5 km), which reduces predicted
              Lp at far receivers. Common alternates: AS 4959 / NSW EPA
              wind-farm modelling sometimes uses 10 °C / 80 %; some European
              tools default to 15 °C / 70 %. Atmospheric pressure is fixed at
              sea level (101.325 kPa) — only matters above ~1000 m elevation.
            </div>
          </section>

          <section className="settings-section">
            <h3>Barrier convention (Abar / Agr interaction)</h3>
            <label className="fld">
              <span>Convention</span>
              <select
                value={draft.barrierConvention ?? 'iso-eq16'}
                onChange={(e) => update({ barrierConvention: e.target.value as 'iso-eq16' | 'dz-minus-max-agr-0' })}
              >
                <option value="iso-eq16">Strict ISO 9613-2 §7.4 Eq 16/17 (default)</option>
                <option value="dz-minus-max-agr-0">Common practice: Abar = Dz − max(Agr, 0)</option>
              </select>
            </label>
            <div className="hint">
              <b>Strict ISO Eq 16/17:</b> when Agr &gt; 0 over-top, Abar absorbs
              Agr — Abar = max(0, Dz − Agr) and Agr is then NOT added separately.
              When Agr ≤ 0 (boost case), Abar = Dz and Agr is added separately.
              <br />
              <b>Common practice variant:</b> Abar = Dz − max(Agr, 0); Agr is
              always added separately. Same numerical result as ISO when Agr ≤ 0
              (boost) or Agr &gt; 0 — only the bookkeeping differs. Choose this
              if your reference tool follows the simpler convention.
              <br />
              No effect on layouts without barriers (and without DEM-derived
              ridges acting as virtual barriers).
            </div>
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
            <h3>Propagation cutoffs</h3>
            <div className="grid-2">
              <label className="fld">
                <span>Max contribution distance (m)</span>
                <input
                  type="number" min={0} step={50}
                  value={draft.propagation?.maxContributionDistanceM ?? 20000}
                  onChange={(e) => update({
                    propagation: {
                      ...(draft.propagation ?? { maxContributionDistanceM: 20000, treeAcceptanceTheta: 1.25 }),
                      maxContributionDistanceM: +e.target.value,
                    },
                  })}
                />
              </label>
              <label className="fld">
                <span>Tree acceptance θ (0.1–2.0)</span>
                <input
                  type="number" min={0.1} max={2} step={0.05}
                  value={draft.propagation?.treeAcceptanceTheta ?? 1.25}
                  onChange={(e) => update({
                    propagation: {
                      ...(draft.propagation ?? { maxContributionDistanceM: 20000, treeAcceptanceTheta: 1.25 }),
                      treeAcceptanceTheta: +e.target.value,
                    },
                  })}
                />
              </label>
            </div>
            <div className="hint">
              <b>Max distance:</b> sources further than this from a receiver are skipped
              entirely (no contribution). Set to <b>0</b> to disable. Default 20 km.
              <br />
              <b>Tree acceptance θ (Barnes-Hut):</b> when a cluster's bounding-box diagonal
              divided by its distance to the receiver is below θ, the cluster is treated as
              one virtual point source (energy-summed Lw at the centroid). Lower = more
              accurate but slower. <b>0.5</b> keeps geometric error well under 1 dB; use
              <b> 0.3</b> for very high accuracy or <b>1.0</b> for faster preview runs.
            </div>
          </section>

          <section className="settings-section">
            <h3>Topography (DEM)</h3>
            <div className="grid-2">
              <label className="fld">
                <span>Path samples per source-receiver pair</span>
                <input
                  type="number" min={0} max={64} step={1}
                  value={draft.topography?.pathSamples ?? 12}
                  onChange={(e) => update({
                    topography: {
                      ...(draft.topography ?? { pathSamples: 12, virtualBarrierMinHeightM: 2 }),
                      pathSamples: Math.max(0, Math.round(+e.target.value)),
                    },
                  })}
                />
              </label>
              <label className="fld">
                <span>Virtual barrier min height (m)</span>
                <input
                  type="number" min={0} max={50} step={0.5}
                  value={draft.topography?.virtualBarrierMinHeightM ?? 2}
                  onChange={(e) => update({
                    topography: {
                      ...(draft.topography ?? { pathSamples: 12, virtualBarrierMinHeightM: 2 }),
                      virtualBarrierMinHeightM: +e.target.value,
                    },
                  })}
                />
              </label>
            </div>
            <div className="hint">
              When a DEM is loaded, the solver samples ground heights along the source→receiver
              line. Ridges that pierce the line of sight by more than the threshold become
              virtual barriers (Abar applies). Set samples to <b>0</b> to fall back to flat ground.
            </div>
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
    </ModalBackdrop>
  );
}
