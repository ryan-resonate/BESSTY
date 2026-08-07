// DXF parsing off the main thread.
//
// A 50 MB drawing is ~4.8 million group-code pairs and about half a second of
// straight-line scanning — on the main thread, half a second of frozen map.
//
// The FILE crosses, not its text. A Blob is structured-cloned by reference, so
// the 50 MB is read once, here; sending the decoded string instead would read
// it on the main thread and then copy it again. The result travelling back is a
// few thousand entities, small even when the input was not.

import { parseDxf, type DxfDocument } from './dxfParse';

interface DxfRequest {
  id: number;
  file: Blob;
}

self.onmessage = (ev: MessageEvent<DxfRequest>) => {
  const { id, file } = ev.data;
  void (async () => {
    try {
      const doc: DxfDocument = parseDxf(await file.text());
      (self as unknown as Worker).postMessage({ id, ok: true, doc });
    } catch (e) {
      (self as unknown as Worker).postMessage({ id, ok: false, error: (e as Error).message ?? String(e) });
    }
  })();
};
