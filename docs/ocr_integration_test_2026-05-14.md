# OCR Integration Test — 2026-05-14

End-to-end validation of an OCR-based order-extraction fallback for receipts that arrive at the agent as rasterized bitmap (the case identified on 2026-05-12 and confirmed on 2026-05-13). Closes the gap that previously forced ERPNext (and any Windows-driver-printing POS) into the local-serial fallback path.

## Environment

| | |
|---|---|
| Production cloud | `https://cloud.skrterak.com` (unchanged from 2026-05-13) |
| Test restaurant | `rest_0k6lu7` (Q1) |
| Real thermal printer | `192.168.1.190:9100` |
| Dev machine | `192.168.1.88` Wi-Fi + IP alias `192.168.1.50` on Ethernet 2 |
| Installed agent (end of session) | `C:\ProgramData\QueueManager\`, Windows service `QueueManager` running, autostart |

## What we proved works

1. **Raw payload capture** — added optional `debug.dump_raw_payloads` flag. When on, the agent writes every intercepted ERPNext print session as a `.bin` to `<data_root>/captures/<ts>--<order|fallback-N>.bin`. Bytes are perfectly preserved, file-per-session, fire-and-forget write so paper output stays in real time.
2. **`GS v 0` raster decoder** — `src/core/extractor/raster.js` parses every `1D 76 30 m xL xH yL yH ...` block in the byte stream, stitches them vertically, and produces a PNG via `pngjs`. Verified by decoding yesterday's `.bin` captures into PNGs that are pixel-perfect reconstructions of the physical receipts (text legible, layout intact).
3. **Tesseract.js OCR on the decoded bitmap** — produces correct order number (`#1410230`) on both yesterday's captures and a fresh print today. Overall confidence is low (~30%) because the engine fights with Arabic letters using the English model, but the digit/`#` glyphs come out clean. With the digit whitelist + `#`-anchored regex (`#\s*(\d{4,})`), extraction is reliable.
4. **End-to-end live test** — fresh print from ERPNext → agent intercepted bytes (32982) → forwarded to real printer (paper out) → bytes empty-of-text → OCR fired (worker init 302 ms, recognition 564 ms) → `new order #1410230 (ocr)` published → cloud sync → staff page showed `#1410230`. **Order number matched the physical paper.** Total wall-clock from print to staff display: ~1 second.
5. **Bundled tessdata (offline OCR)** — `src/core/extractor/tessdata/eng.traineddata.gz` (1.9 MB, gzipped `tessdata_fast` variant) populated by `npm run vendor`. Agent's OCR engine detects it, sets `cacheMethod: 'none'`, and reads directly with zero CDN traffic. Verified with `source: 'bundled'` in the worker-init log.
6. **`setup-helper.js debug-capture-{enable,disable,status}`** — three new subcommands to toggle `debug.dump_raw_payloads` in any config file. Schema-validates the resulting JSON before writing. Reminds operator to restart the service for the change to take effect.
7. **Install-side migration** — `scripts/install.bat` (repo layout) successfully replaced the previous (pre-OCR, rest_knk8aa, dead-mock-cloud) installation with today's code talking to production cloud. Boot log shows OCR enabled, raw-payload dumping enabled, cloud WS connected, printer connected, interceptor bound on `192.168.1.50:9100`.

## Problems we hit and how we resolved them

### 1. Lost the raw bytes from 2026-05-13 — no way to iterate on regex offline

**Symptom:** Yesterday's 32982-byte ERPNext stream was passed through the extractor in memory and then GC'd. The only log line about its content was a truncated 80-char `text_preview` of best-effort UTF-8 decode (which is just bitmap garbage). Any change to the regex would need a fresh physical print to test.

**Cause:** By design — the agent doesn't persist raw payloads in production for privacy reasons (the bytes contain customer order details).

**Fix:** Added `debug.dump_raw_payloads: bool` to the config schema and a small writer in the order handler (`src/index.js`). When on at boot, ensures `<data_root>/captures/` exists; on each order event, fire-and-forget writes `<ts>--<tag>.bin` with the raw bytes. Off by default — capturing only when an operator explicitly turns it on for debugging.

### 2. The order number on the receipt has a `#` prefix the regex didn't expect

**Symptom:** Once we confirmed the receipt template (image from user) showed `رقم الطلب: #14093535`, the existing regex `رقم الطلب:?\s*(\d+)` would *still* fail to capture even from a plain-text byte stream — there's a `#` between the label and the digits.

**Cause:** Regex pattern doesn't allow for the literal `#`.

**Fix:** Updated `extractor.regex` to `رقم الطلب:?\s*#?\s*(\d+)` and added a separate `extractor.ocr.regex` of `#\s*(\d{4,})` for the OCR path. The OCR pattern is anchored on `#` because that's the most reliable glyph in an OCR result full of misread Arabic.

### 3. Tesseract.js needs `eng.traineddata.gz`, not plain `eng.traineddata`

**Symptom:** First try at bundling failed with `ENOENT: ... eng.traineddata.gz` after we set `langPath` + `cacheMethod: 'none'`. The downloaded file from `tessdata_fast/main/eng.traineddata` (GitHub raw) is uncompressed.

**Cause:** Tesseract.js's offline path expects the gzipped form.

**Fix:** `scripts/vendor-fetch.js` now downloads the raw file to a temp location, gzips it via `zlib.gzipSync(..., Z_BEST_COMPRESSION)`, and writes the result as `eng.traineddata.gz`. Side benefit: 3.9 MB → 1.9 MB on disk.

### 4. Pre-existing data in the install path

**Symptom:** `C:\ProgramData\QueueManager\data\active_orders.jsonl` had a couple of orders from yesterday's `rest_knk8aa` test runs. Without cleanup, the new install would have shown those as ghost orders on the staff page.

**Fix:** `Remove-Item C:\ProgramData\QueueManager\data\*.jsonl -Force` from admin PowerShell before running `install.bat`. Verified by boot log: `loaded 0 active orders from 0 events`.

### 5. Post-install verify print — order published, but no paper

**Symptom:** First print from ERPNext after the install (order `#1411320`) succeeded end-to-end at the agent level — bytes captured, OCR ran from bundled tessdata, order extracted correctly, published to cloud, visible on staff page — **but no paper came out of the physical printer**. Log was missing the usual `(interceptor) printer status: ok` line.

**Diagnosis:** A race condition in `src/core/interceptor/index.js`. The interceptor opens a TCP connection to the real printer (`printer_new_ip:port`) the moment a cashier connects, and buffers cashier bytes in `session.pendingForPrinter` until that connect completes. After 500 ms of cashier-side idle, `_processOrder` fires, sets `session.processed = true`, and ends the sockets. **If the printer connect finishes after `_processOrder`**, the `sock.once('connect', ...)` handler hit a `return` on `if (session.processed)` — closing the socket without ever flushing the queued bytes. Result: order data flows everywhere except the printer.

Why now: previously the dev agent kept the printer-forward socket "warm" across rapid back-to-back test prints, so the connect was sub-millisecond. The installed service starting fresh against a printer that may have gone to sleep was a different timing profile.

Confirmed printer hardware was fine by sending 48 bytes of raw ESC/POS directly from PowerShell to `192.168.1.190:9100` — paper came out immediately.

**Fix:** In the `connect` handler, always drain `pendingForPrinter` first, then check `session.processed` (close if so, otherwise become the live forwarding socket). Added an info log `printer connect won after extraction — flushed buffered bytes` to surface the race-recovery case if it happens. Deployed by copying the one file to `C:\ProgramData\QueueManager\agent\src\core\interceptor\index.js` and `Restart-Service QueueManager`. Verified: next print (order `#1411433`) came out on paper *and* hit the cloud, log this time showed the normal happy path (`printer status: ok` before OCR).

Memory: `project-interceptor-forward-race`.

## Architecture clarifications

- **Extraction is now two-path.** Default flow: try `extractor.regex` against text-decoded bytes. If miss AND `GS v 0` raster blocks are present AND OCR is enabled, decode → stitch → Tesseract → match `extractor.ocr.regex`. Else fallback serial. The order event grows a `method: 'text' | 'ocr' | 'fallback'` field so logs and metrics can split paths.
- **Paper printing is unaffected by OCR.** `src/core/interceptor/index.js:153-184` forwards every byte to the real printer as it arrives. OCR only runs in the order handler after the idle-timeout, so it can only delay the staff-page event, never the receipt itself.
- **OCR worker is long-lived.** Lazily initialized on the first OCR call, reused for the life of the agent. Bundled-tessdata path adds ~200 ms init + ~500–700 ms per recognition; CDN-tessdata path adds ~5–10 s on the very first call (one-time download). Worker terminated through the cleanup chain on shutdown.
- **Confidence ≠ correctness for this use case.** Tesseract reports ~30% overall confidence on our receipts because it's trying to read Arabic letters with the English model. The order number is reliable anyway because (a) the digits are Latin numerals, (b) `#` is a strong unambiguous anchor, (c) the regex constrains to 4+ contiguous digits. Don't reject OCR results based on overall confidence — trust the regex match.
- **Vendor fetch now bundles three things**: portable Node, NSSM, and tessdata. `npm run vendor` is the canonical step before `npm run package`. Tessdata destination is inside `src/` (`src/core/extractor/tessdata/eng.traineddata.gz`) so it travels automatically with `install.bat`'s robocopy of `src/` and with `package.js`'s `cpSync` of `src/` — no separate copy step needed.

## State of the dev machine at end of session

| Item | State |
|---|---|
| Windows service `QueueManager` | **RUNNING**, autostart `Automatic`. Layout: `C:\ProgramData\QueueManager\`. Config: `config\config.json` (= today's production config — rest_0k6lu7, cloud.skrterak.com). |
| Service bindings | Port 9100 on `192.168.1.50` (specific-IP), port 9299 on `0.0.0.0` (HTTP+WS). |
| Installed agent code | Includes `raster.js`, `ocr.js`, bundled tessdata, new `setup-helper.js` with debug-capture commands, pngjs + tesseract.js + tesseract.js-core in node_modules. |
| Repo `config/config.json` | Synced from `config/config.skrterak.json` (one-time copy during migration). The `config.skrterak.json` file is still present for dev convenience. |
| `debug.dump_raw_payloads` | **true** in both the dev config and the installed config. Worth turning off in the installed config eventually since the system works now and captures take disk. |
| Cloud `cloud.skrterak.com` | Live, agent connected and reconnecting cleanly. Saw one `code: 4000 reason: "replaced"` event during migration — that's the cloud kicking the stale dev-agent connection when the new service connected. |
| Dev agent (foreground for tests) | **STOPPED** (killed before install.bat). The dev-agent workflow now requires `Stop-Service QueueManager` first to free port 9100. |
| IP alias `192.168.1.50` on Ethernet 2 | Present. |
| `tmp/qm-dev/data/captures/` | Three `.bin` files from this session (fallback-1, fallback-2, n1410230). Plus the PNG for fallback-2 generated by `scripts/decode-capture.js` during verification. Safe to delete. |
| ERPNext (browser POS) | Unchanged. Still printing through the Windows printer redirected to `192.168.1.50:9100`. We did NOT switch the driver, change the print format, or touch anything ERPNext-side. |

## Open issues / next steps

1. ~~**Final verify print against the installed service.**~~ Done — exposed Problem 5 (forward race), fixed, re-verified with order `#1411433` (paper out + staff page updated).
2. **Decide on `debug.dump_raw_payloads` in the installed config.** Currently `true`. For production it should be `false` (privacy, disk). Toggle with `node C:\ProgramData\QueueManager\setup-helper.js debug-capture-disable C:\ProgramData\QueueManager\config\config.json` then `Restart-Service QueueManager`.
3. **OCR accuracy sanity bound.** The current OCR regex `#\s*(\d{4,})` enforces a minimum of 4 digits, which catches most Tesseract misreads. Could tighten with a max bound (`{4,12}`) if any real-world misread produces an absurdly long number.
4. **Add CDN-tessdata removal.** Right now if the bundled file is somehow missing, the agent silently falls back to CDN download. That's good for dev but might mask a packaging bug in production. Consider failing closed (refuse to OCR) when bundled tessdata is missing, behind a config flag.
5. **Test mode / `scripts/test-integration.js`.** The extractor is now async — verified the production handler awaits it, but worth running the test suite or smoke test once to confirm no other call site was missed.
6. **Yesterday's open items still apply:** clock-sync precondition in installation_runbook.md, `CERT_NOT_YET_VALID` log hint, inbound WS test (push a `settings_updated` from admin panel).

## How to resume in the next session

```powershell
# 1. Service status
Get-Service QueueManager

# 2. Tail recent log
Get-Content C:\ProgramData\QueueManager\logs\stdout.log -Tail 30

# 3. Check capture flag state
node C:\ProgramData\QueueManager\setup-helper.js debug-capture-status C:\ProgramData\QueueManager\config\config.json

# 4. If iterating on agent code, stop service and run dev agent against the repo
Stop-Service QueueManager  # admin shell
$env:QM_CONFIG_FILE = "config\config.skrterak.json"
$env:QM_DATA_ROOT   = "tmp\qm-dev"
node src\index.js
# (when done, kill the node process and Start-Service QueueManager)
```

## Reference

- Prior sessions: `docs/printer_integration_test_2026-05-12.md`, `docs/cloud_integration_test_2026-05-13.md`
- Raster decoder + OCR engine: `src/core/extractor/raster.js`, `src/core/extractor/ocr.js`
- Bundled tessdata: `src/core/extractor/tessdata/eng.traineddata.gz` (populated by `npm run vendor`)
- Test scripts: `scripts/decode-capture.js` (bin → png), `scripts/ocr-capture.js` (bin → OCR text)
- Saved memories: `project-ocr-fallback`, `feedback-no-manipulate-customer-env`, and the updated `project-agent-intercept-scope`
