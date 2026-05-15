# First Restaurant Deployment Checklist

A working sheet a field technician can carry on-site. Walk through it top to bottom; do not skip steps without understanding what they catch.

Built from lessons in `printer_integration_test_2026-05-12.md`, `cloud_integration_test_2026-05-13.md`, and `ocr_integration_test_2026-05-14.md`. If any step in this document conflicts with the older `installation_runbook.md`, **this document wins** — it is the more recent operational truth.

---

## A. Off-site preparation (day before the visit)

### A.1 Generate the restaurant's config

- [ ] Create the restaurant in the admin panel. Capture `restaurant_id` and `api_key`.
- [ ] Open the generated `config.json` and **manually verify each of these**, because the admin panel has emitted broken configs before:
  - [ ] `cloud.base_url` is `https://cloud.skrterak.com` (not `localhost`, not `192.168.x.x`).
  - [ ] `cloud.ws_url` is `wss://cloud.skrterak.com/ws`.
  - [ ] `staff_pin` is at the **root level**, not under `restaurant`. (Schema requires root — admin panel has put it in the wrong place in the past.)
  - [ ] `extractor.regex` matches the restaurant's receipt template. Print a sample receipt from their POS first; eyeball where the order number is and what text precedes it.
  - [ ] **If the restaurant's POS rasterizes** (ERPNext via browser, anything going through "Devices and Printers" → a real Windows printer driver): add this block under `extractor`:
    ```json
    "ocr": {
      "enabled": true,
      "regex": "#\\s*(\\d{4,})"
    }
    ```
    Adjust the regex to match their order-number format (`#`-prefixed, no prefix, leading zeros, etc.). If you don't know, leave the `#`-prefixed default and verify with a test print on-site — switch the regex if extraction misses.
  - [ ] `network.cashier_ip` is the cashier PC's IP **as seen by the agent machine**, not a same-machine simulation value. Confirm with the restaurant before the visit.
  - [ ] `network.printer_new_ip` is the real thermal printer's IP.
  - [ ] `network.printer_old_ip` is the IP the agent will *take over* — usually the same as `printer_new_ip` if the cashier POS was previously printing directly to the real printer. The agent claims this IP via netsh alias.
  - [ ] `network.printer_port` is 9100 unless the printer is unusual.
  - [ ] `network.interface_name` is the **exact Windows adapter name** of the cashier machine's wired Ethernet (e.g. `Ethernet`, `Ethernet 2`). **Do not use `auto`** — auto-detection has picked virtual adapters in the past (VBox Host-Only on the dev machine, 2026-05-12 §2). Ask the restaurant or check on first arrival.

### A.2 Bundle the installer

- [ ] From the repo on a dev machine: `npm install`
- [ ] `npm run vendor` — downloads portable Node, NSSM, and `eng.traineddata.gz`. **Verify all three appear** in `vendor/` and `src/core/extractor/tessdata/`.
- [ ] `npm run package` — produces `dist/queue-manager-installer/`.
- [ ] Drop the validated `config.json` into the bundle root (overwrite the example template).
- [ ] Zip the folder. Bring it on a USB stick AND a copy in cloud storage as backup.

### A.3 Information to bring on-site

- [ ] Restaurant's admin-panel login.
- [ ] Restaurant's `restaurant_id` and `api_key` (printed; in case config edit is needed on-site).
- [ ] Cashier PC IP / hostname.
- [ ] Real printer IP.
- [ ] A staff/tablet device to verify the staff page from the customer-screen side.

---

## B. On-site pre-checks (before running install.bat)

### B.1 Cashier PC sanity

- [ ] Windows 10 or 11.
- [ ] **Wired Ethernet to the LAN**, not Wi-Fi. (`netsh interface ip add address` on a DHCP Wi-Fi adapter silently converts it to static and breaks internet — see `feedback_netsh_dhcp_danger`.)
- [ ] The cashier's IP is **static** (or a DHCP reservation that won't change). The agent's alias is on a specific IP — if DHCP changes the underlying IP, things break.
- [ ] **Clock is synced.** Open admin PowerShell and run:
  ```powershell
  w32tm /resync /force
  ```
  If you skip this and the clock is more than a few hours behind real UTC, Node TLS will reject the cloud cert with `CERT_NOT_YET_VALID` and the agent will fail to connect — even though `curl` will work fine. See `feedback_clock_sync_required`.
- [ ] At least 500 MB free disk space.
- [ ] Local admin rights for the install user.

### B.2 Cloud reachability from the cashier PC

- [ ] `curl https://cloud.skrterak.com/health` returns `200 {"status":"ok",...}`.
- [ ] After config is in place but **before** install, run from the staged installer folder:
  ```
  node setup-helper.js verify-cloud config.json
  ```
  Expect `OK_HTTP /health (status 200)` and `OK_WS /local-agent`. This uses the agent's own TLS stack — catches things `curl` doesn't (e.g., clock skew).

### B.3 Printer sanity

- [ ] Printer powered on, paper loaded, no error lights.
- [ ] Printer's network IP is what's in `config.json` (`printer_new_ip`).
- [ ] **Send a direct test print** from the cashier PC to confirm the printer hardware is fine before we add the agent in the middle:
  ```powershell
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('<printer_ip>', 9100)
  $stream = $client.GetStream()
  $bytes = [byte[]]@(0x1B,0x40) + [System.Text.Encoding]::ASCII.GetBytes("Pre-install test`n") + [byte[]]@(0x1D,0x56,0x00)
  $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
  Start-Sleep -Milliseconds 200; $client.Close()
  ```
  Paper should come out. If it doesn't, **stop and fix the printer first.** The agent can't conjure paper.

### B.4 Network discovery sanity

- [ ] From the staged installer folder, run:
  ```
  node setup-helper.js list-adapters config.json
  ```
  Prints every adapter with its IPv4, flags virtual/wireless adapters, marks which ones share a subnet with the printer, and recommends one. Use the recommended name (or pick another wired adapter manually if it looks wrong) for `network.interface_name`. Copy the name exactly — case, spaces, and digits all matter.
- [ ] Sanity check: `Get-NetAdapter` on the cashier PC — the adapter you picked must appear in that list exactly as written.
- [ ] `Test-NetConnection -ComputerName <printer_ip> -Port 9100 -InformationLevel Quiet` returns `True` from the cashier PC.

### B.5 Identify what the cashier POS currently does

- [ ] Is the POS configured to print to the **real printer IP** directly? If yes: setting `printer_old_ip = printer_new_ip` works — the agent takes over the IP transparently, no change to POS.
- [ ] Is the POS using a **Windows printer driver** (Devices and Printers entry pointing at a Standard TCP/IP port)? If yes: the POS will likely emit raster, so OCR config must be enabled (§A.1). The Standard TCP/IP port can be redirected to `printer_old_ip` if needed.
- [ ] Is the POS browser-based with no raw-TCP option? It will need Windows driver routing through the agent — same as above.

---

## C. Install

- [ ] Copy the staged installer folder to a path with **no spaces** (e.g., `C:\QM-Install\`). Spaces have caused `install.bat` quoting bugs before (2026-05-12 §1) — the current code handles them, but defense in depth.
- [ ] Open **Administrator** PowerShell.
- [ ] `cd C:\QM-Install`
- [ ] `.\install.bat`
- [ ] Read every line of output. There are 12 numbered steps. Any step printing `ERROR:` means **stop and diagnose** — do not continue with a partial install.
- [ ] At the "Continue with installation? (y/N):" prompt, only type `y` if the printed summary matches what you intend.

---

## D. Post-install verification

### D.1 Service and bindings

- [ ] `Get-Service QueueManager` → `Status: Running`, `StartType: Automatic`.
- [ ] `Get-NetTCPConnection -LocalPort 9100 -State Listen` → bound on the alias IP (`printer_old_ip` from config), not just `0.0.0.0`. (Specific-IP bind beats wildcard binds for connection routing on Windows — `cloud_integration_test_2026-05-13.md` §4.)
- [ ] `Get-NetTCPConnection -LocalPort 9299 -State Listen` → bound on `0.0.0.0` (the local HTTP+WS server).

### D.2 Log sanity

```powershell
Get-Content C:\ProgramData\QueueManager\logs\stdout.log -Tail 30
```

Look for:
- [ ] `بدء التشغيل — Queue Manager` (startup line)
- [ ] `cloud WS connected`
- [ ] `print interceptor listening on <alias_ip>:9100 {"target":"<real_printer_ip>:9100", ...}`
- [ ] If OCR is configured: `OCR fallback enabled {"regex":"..."}`
- [ ] If OCR is configured: bundled tessdata path should trigger `source: "bundled"` on first OCR (will appear after the first print).
- [ ] **No** `CERT_NOT_YET_VALID` (means clock is bad — fix B.1 and restart).
- [ ] **No** `printer not reachable` warnings persisting past startup (means physical printer is unreachable from the agent — fix B.3).

### D.3 Live end-to-end test

- [ ] Trigger a real print from the cashier POS (a low-value test order or duplicate of an existing one).
- [ ] **Paper comes out the real printer** within ~1 second of clicking print.
- [ ] In the log, look for `new order #N (<method>) {...}`. The `<method>` should be:
  - `text` for raw-ESC/POS POS systems (the fast happy path).
  - `ocr` for Windows-driver / rasterizing POS systems (requires OCR config from §A.1).
  - `fallback` means **extraction failed** — order published with a wrong sequential number. STOP and check the regex against the receipt template.
- [ ] The order's number on screen matches the number printed on paper. If they don't match, the regex is wrong — fix it.
- [ ] Open the staff page (the restaurant's manager/cashier on a tablet or phone) → the order appears within ~1 second of paper.
- [ ] Mark the order done from the staff page → it disappears.
- [ ] Customer-facing display (`display.html`) shows the order and reflects status changes.

### D.4 Reboot test

- [ ] Restart the cashier PC.
- [ ] After reboot, repeat §D.1 and §D.3 — confirm everything still works after a cold start without anyone logging in.

---

## E. Hand-off to restaurant staff

- [ ] Show the manager how to view orders on the staff page.
- [ ] Show the manager how to mark orders done.
- [ ] Show the manager how to change the staff PIN if needed (admin panel).
- [ ] Give the manager: admin-panel URL, restaurant login, support contact info.
- [ ] Confirm the customer-facing display screen is in the right place, visible to customers, on, and showing the test orders correctly.

---

## F. Operational hardening (do before leaving the site)

- [ ] **Verify `debug.dump_raw_payloads` is off** (the shipped config is `false` by default — this is a paranoia check that nothing got flipped on during the visit):
  ```powershell
  node C:\ProgramData\QueueManager\setup-helper.js debug-capture-status C:\ProgramData\QueueManager\config\config.json
  ```
  Expect `DUMP_RAW_PAYLOADS=0`. The boot banner will also print a `⚠ debug.dump_raw_payloads مُفعَّل` line in `stdout.log` if it is on — grep for it. If on, disable and restart:
  ```powershell
  node C:\ProgramData\QueueManager\setup-helper.js debug-capture-disable C:\ProgramData\QueueManager\config\config.json
  Restart-Service QueueManager
  ```
- [ ] Remove any test orders from the staff page (or let staff clear them).
- [ ] Tell the manager: "If something looks wrong, call us. Don't restart the cashier PC — that just delays diagnosis."

---

## G. First 24 hours (remote)

- [ ] Confirm the agent's heartbeat / cloud connection stays live on the cloud dashboard.
- [ ] Watch for: orders with `method: fallback` (extraction is regex-wrong), missing `printer status: ok` log lines (forwarding race — should be fixed after 2026-05-14 but worth watching), `cloud WS closed` storms.
- [ ] Call the manager at close of business day 1: "Did anything look wrong today?"

## H. First week

- [ ] Daily glance: agent uptime, order count sanity, any error-level log lines.
- [ ] End of week: if `debug.dump_raw_payloads` was on, review the captured `.bin` files for any OCR misreads — every misread is a regex-tightening opportunity.
- [ ] If everything is clean for 7 days, you can call the pilot stable.

---

## Common failure modes — quick triage

| Symptom | Likely cause | Where to look |
|---|---|---|
| Service won't start | Config validation error | `setup-helper.js verify-config` against installed config |
| Cloud WS never connects, `CERT_NOT_YET_VALID` | Clock is behind real UTC | `w32tm /resync /force`, restart service |
| Cloud WS never connects, no cert error | Internet down, firewall, wrong cloud URL | `curl https://cloud.skrterak.com/health` from cashier PC |
| Service connects but no orders ever arrive | Cashier POS pointing to wrong IP, or two agents binding port 9100 | `Get-NetTCPConnection -LocalPort 9100`; check what POS is configured to print to |
| Orders arrive but all `method: fallback` | Regex doesn't match the receipt | Enable `debug.dump_raw_payloads`, print a receipt, inspect the `.bin`; for rasterizing POS, decode with `scripts/decode-capture.js` and verify the receipt text |
| Orders arrive correctly but no paper | Forwarding race (should be fixed) OR printer offline OR printer sleeping | Check log for `printer status: failed`; direct-print test §B.3 |
| Wrong order number on screen | OCR misread (rare) OR regex bug | Compare `.bin` decode to staff-page number |
| `rejected non-cashier TCP connection` warning | `cashier_ip` in config doesn't match actual cashier source IP | Update config to match observed source IP; restart |

---

## Reference

- Saved memories that codify the lessons: `project-agent-intercept-scope`, `project-ocr-fallback`, `project-interceptor-forward-race`, `feedback-no-manipulate-customer-env`, `feedback-netsh-dhcp-danger`, `feedback-clock-sync-required`.
- Prior session diagnostics: `docs/printer_integration_test_2026-05-12.md`, `docs/cloud_integration_test_2026-05-13.md`, `docs/ocr_integration_test_2026-05-14.md`.
- The older `docs/installation_runbook.md` is now superseded by this document where they conflict.
