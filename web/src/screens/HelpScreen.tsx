// User guide. Reachable from the header `?` icon. Plain HTML structure
// — no interactive widgets — so it can also serve as the printable
// reference for new starters. Kept in sync with the side-panel tab order
// so users can read top-to-bottom and follow along on screen.
//
// We don't use plain `href="#section"` for the TOC because the app sits
// inside a HashRouter — the URL fragment is owned by the router, so the
// browser's native anchor scroll never fires. We instead resolve the
// element by id and call `scrollIntoView` on click, which keeps the URL
// untouched and works regardless of the routing strategy.

import { Link } from 'react-router-dom';

const TOC_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'workflow',    label: 'Workflow at a glance' },
  { id: 'sources',     label: 'Sources' },
  { id: 'area',        label: 'Calculation area' },
  { id: 'receivers',   label: 'Receivers' },
  { id: 'barriers',    label: 'Barriers' },
  { id: 'import',      label: 'Importing data' },
  { id: 'settings',    label: 'Settings' },
  { id: 'results',     label: 'Results' },
  { id: 'layers',      label: 'Layers' },
  { id: '3d',          label: '3D view' },
  { id: 'shortcuts',   label: 'Keyboard shortcuts' },
  { id: 'methodology', label: 'Acoustic methodology' },
];

function scrollToSection(id: string) {
  // Find the section inside the help-screen scroll container, NOT
  // window — the page lives inside a fixed-height scrolling div.
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function HelpScreen() {
  return (
    <div className="help-screen">
      <h1>BESSTY user guide</h1>
      <p className="hint" style={{ maxWidth: 720 }}>
        BESSTY computes outdoor noise propagation per ISO 9613-2:2024 — wind
        farms, BESS yards, and auxiliary equipment all in the one project. The
        solver runs in your browser via WebAssembly; nothing leaves the device
        beyond the basemap / DEM tile fetches.
      </p>

      <nav className="help-toc">
        {TOC_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="help-toc-link"
            onClick={() => scrollToSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <section id="workflow">
        <h2>Workflow at a glance</h2>
        <ol>
          <li><b>Sources</b> — drop wind turbines, BESS pads, and auxiliary equipment on the map. Pick the model from the catalog (or import your own).</li>
          <li><b>Calculation area</b> — set the rectangle of interest. The grid spacing auto-picks on first creation; tweak in Settings.</li>
          <li><b>Receivers</b> — drop named receivers at sensitive locations (homes, schools). Set per-period limits.</li>
          <li><b>Barriers</b> — optional walls or terrain features that diffract sound. Heights are entered in metres above local ground.</li>
          <li><b>Run grid</b> — produces the contour raster. Drag any source to extrapolate immediately; the snapshot refreshes in the background.</li>
          <li><b>Export</b> — receiver totals (CSV/XLSX), per-source contributions, per-band spectra, contour lines (KML/SHP), and the grid raster (GeoTIFF).</li>
        </ol>
      </section>

      <section id="sources">
        <h2>Sources</h2>
        <p>
          Three kinds: <b>WTG</b> (wind turbines), <b>BESS</b> (battery enclosures
          with fan noise), and <b>Auxiliary</b> (transformers, inverters, anything
          else). Each source references a <b>catalog model</b> that supplies the
          per-band sound power; a <b>mode</b> picks one of several emission
          conditions (e.g. NRO+0, full fan speed). Sources without geometry use
          a default 1.5 m elevation offset; WTGs use their hub height.
        </p>
        <p>
          The Sources tab groups sources by kind into collapsed sub-cards. They
          stay collapsed by default; expand a card and the choice persists for
          the rest of your session.
        </p>
        <p className="hint">
          Wind speed sets the operating mode lookup for WTG catalog entries
          that report per-wind-speed spectra. Set it once at the project level
          (Sources tab) — it isn't a receiver-by-receiver knob.
        </p>
      </section>

      <section id="area">
        <h2>Calculation area</h2>
        <p>
          The yellow dashed rectangle on the map. Drag the centre handle to
          move it; drag a corner handle to resize. The numeric inputs in the
          Area tab always reflect the current geometry. The grid spacing
          auto-adapts on first creation (~200 cells per side) and locks
          against the user's choice once the picker is touched.
        </p>
        <p className="hint">
          A larger calc area takes longer to evaluate; the cell count is shown
          beneath the spacing dropdown.
        </p>
      </section>

      <section id="receivers">
        <h2>Receivers</h2>
        <p>
          Click <b>+ Receiver</b> then click on the map. Each receiver has a
          name (click-to-edit), a height above ground (m), and three period
          limits in dB(A): day / evening / night. The active period sits
          highlighted in yellow on the receiver row and is the one used to
          colour the pass-fail badge.
        </p>
        <p>
          Selected receivers can be group-dragged together with sources to
          reposition layouts. Multi-select via shift-click or LMB box-drag.
        </p>
      </section>

      <section id="barriers">
        <h2>Barriers</h2>
        <p>
          Click <b>+ Barrier</b>, then click two points on the map to drop a
          straight wall between them. Each barrier carries a top height (m
          above local ground) — edited inline in the Barriers tab list. The
          solver applies <code>Abar</code> per ISO 9613-2 §7.4 along every
          source → receiver path that the wall intersects, combining the
          per-band <code>Dz</code> with <code>Agr</code> per the convention
          chosen in Settings.
        </p>
        <p className="hint">
          Esc cancels an in-progress draw. The map shows each barrier with a
          height label at its midpoint.
        </p>
      </section>

      <section id="import">
        <h2>Importing data</h2>
        <p>
          The Import tab supports CSV, KML, and shapefile (.zip) uploads. The
          dialog asks which kind to import as (receivers, WTGs, BESS,
          auxiliary) and lets you map source columns to project fields. CSV
          and shapefile (without .prj) accept any registered projected CRS;
          GeoTIFF DEMs the same.
        </p>
      </section>

      <section id="settings">
        <h2>Settings</h2>
        <ul>
          <li><b>Band system</b> — octave (10 bands) is faster; one-third octave (31 bands) catches narrowband content.</li>
          <li><b>Ground</b> — default G factor (0 hard, 1 porous). Annex D rules cap at 0.5 for WTGs regardless.</li>
          <li><b>DΩ</b> — solid-angle correction. <b>+3 dB</b> is the default (matches CONCAWE, AS 4959, etc.); <b>0 dB</b> is strict ISO.</li>
          <li><b>Atmosphere</b> — temperature + relative humidity drive ISO 9613-1 absorption α(f), evaluated inside the WASM solver.</li>
          <li><b>Barrier convention</b> — picks how Abar combines with Agr. The recommended variant matches reference tools.</li>
          <li><b>Diffraction limit</b> — optional per-band cap on Dz for non-WTG sources (common project values: 2 or 5 dB). WTGs use the Annex D cap independently.</li>
          <li><b>Annex D</b> — wind-turbine specifics. Barrier Abar cap (default 3 dB), tip-height-as-source toggle, concave correction (−3 dB), and the 4 m receiver height clamp.</li>
          <li><b>Propagation cutoffs</b> — distance cutoff (sources further than X are skipped) and Barnes-Hut θ for source clustering. Lower θ = more accurate, slower.</li>
          <li><b>Topography</b> — DEM path-sampling controls. Ridges that pierce line-of-sight by more than the threshold become virtual barriers.</li>
          <li><b>Drag extrapolation caps</b> — when Taylor extrapolation exceeds these caps during a drag, the displayed value clamps and a re-snapshot is queued in the background.</li>
        </ul>
      </section>

      <section id="results">
        <h2>Results</h2>
        <p>
          The Run button computes the contour grid. Receiver totals + per-source
          contributions + per-band spectra all export to CSV / XLSX. Contour
          lines export to KML or shapefile (.zip) and the grid raster to
          GeoTIFF. The on-screen pass / fail summary uses the active scenario
          period.
        </p>
      </section>

      <section id="layers">
        <h2>Layers</h2>
        <p>
          Toggle base map (satellite / OSM), contour mode (filled, lines, both),
          contour palette and step, and a debug overlay that paints every grid
          cell centre — useful when you suspect alignment issues with another
          tool's output.
        </p>
        <p className="hint">
          Min / Max in the Layers tab drive both the contour line thresholds
          and the filled-grid colour scale. Press <b>Auto-fit</b> to clamp
          them to the current grid's measured range.
        </p>
      </section>

      <section id="3d">
        <h2>3D view</h2>
        <p>
          Open the 3D dialog from the floating map controls. Sources and
          receivers render at their actual height above the local DEM — WTGs
          as thin lines from ground to hub, BESS as small cuboids, auxiliary
          equipment as smaller cuboids, receivers as small spheres at HAG.
          The vertical exaggeration slider in the dialog header scales BOTH
          the terrain mesh AND the object heights uniformly (1× = true scale,
          5× makes hub-vs-receiver differences obvious).
        </p>
      </section>

      <section id="shortcuts">
        <h2>Keyboard shortcuts</h2>
        <table className="help-table">
          <thead>
            <tr><th>Key</th><th>Action</th></tr>
          </thead>
          <tbody>
            <tr><td>Esc</td><td>Cancel any active add / measure / barrier mode AND clear the current selection.</td></tr>
            <tr><td>Del / Backspace</td><td>Delete the current selection (sources, receivers, barriers).</td></tr>
            <tr><td>Ctrl + Z</td><td>Undo (50 entries deep).</td></tr>
            <tr><td>Ctrl + Shift + Z / Ctrl + Y</td><td>Redo.</td></tr>
            <tr><td>Shift + click</td><td>Toggle membership in the selection.</td></tr>
            <tr><td>LMB drag (empty map)</td><td>Box-select sources + receivers.</td></tr>
            <tr><td>MMB drag</td><td>Pan the map (Leaflet's left-button drag is repurposed for box-select).</td></tr>
          </tbody>
        </table>
      </section>

      <section id="methodology">
        <h2>Acoustic methodology</h2>
        <p>
          The solver implements:
        </p>
        <ul>
          <li><b>Adiv</b> (§7.1) — geometric divergence, <code>20·log10(d) + 11</code>.</li>
          <li><b>Aatm</b> (§7.2 + ISO 9613-1 §8) — atmospheric absorption α(f, T, RH, p), closed-form per band, evaluated inside the WASM solver from the project's Atmosphere settings.</li>
          <li><b>Agr</b> (§7.3.1, General method) — three-region ground attenuation with the published shape functions.</li>
          <li><b>Abar</b> (§7.4.1) — over-top diffraction for straight wall barriers, single + multi-edge rubber-band path. Lateral diffraction (§7.4.3) is deferred.</li>
          <li><b>Annex D</b> — wind-turbine-specific G cap (0.5), receiver-height clamp (4 m), elevated-source-for-barrier (hub + rotor radius), Abar cap (3 dB), and concave-ground correction (−3 dB).</li>
        </ul>
        <p>
          Cluster aggregation uses a Barnes-Hut treecode (one-directional FMM
          analog) to fold distant source groups into a single virtual point.
          Per-receiver contributions always solve directly — no clustering on
          named receiver rows.
        </p>
      </section>

      <p style={{ marginTop: 32 }}>
        <Link to="/projects">← Back to projects</Link>
      </p>
    </div>
  );
}
