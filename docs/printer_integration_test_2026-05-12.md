# Printer Integration Test — 2026-05-12

End-to-end validation of the Queue Manager agent against a real network thermal printer, including production-style Windows service deployment.

## Hardware

| | |
|---|---|
| Printer IP | `192.168.1.190` |
| Printer port | `9100` (raw ESC/POS) |
| Dev machine | `192.168.1.88` (Wi-Fi, DHCP) |
| Transport confirmed | Raw TCP, ESC/POS bytes (`ESC @` init + text + `GS V 0` cut) |

## What we proved works

1. **Hardware** — raw TCP to `192.168.1.190:9100` prints + cuts. Verified with PowerShell `TcpClient` sending ESC/POS bytes.
2. **Agent in dev mode** (`node src/index.js`) — interceptor accepts loopback, forwards to real printer, extracts Arabic order number. Test print produced order `#42` on the display.
3. **Agent as Windows service** (after `scripts\install.bat`) — same end-to-end flow worked. Test print produced order `#99` on the display.
4. **ERPNext (browser POS) through the agent** — by redirecting the Windows printer's Standard TCP/IP Port from `192.168.1.190` to `192.168.1.50`, ERPNext's print button routed bytes through the agent to the real printer. Paper came out.

## Problems we hit and how we resolved them

### 1. `install.bat` failed silently on paths with spaces
**Symptom:** Window closed immediately. Running from an admin shell revealed:
```
'C:\Program' is not recognized as an internal or external command
ERROR: failed to extract config value
```
**Cause:** Line 115 — `for /f "usebackq tokens=1,* delims==" %%a in (\`"%NODE_EXE%" ...\`)`. CMD strips one layer of quotes when parsing the backquoted command, leaving `C:\Program Files\nodejs\node.exe` unquoted.

**Fix:** Wrapped the entire backquoted command in another pair of quotes so the inner ones survive:
```bat
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_EXE%" "%PKG_ROOT%\setup-helper.js" extract-vars "%CONFIG_SOURCE%""`) do (
```

**Prereq that's still required:** `nssm.exe` must be at the repo root for the `scripts\` layout. Currently it ships only under `vendor\` and `dist\queue-manager-installer\` — copy `vendor\nssm.exe` to repo root before running `scripts\install.bat`.

### 2. `interface_name: "auto"` picked the wrong NIC
**Symptom:** The IP alias `192.168.1.50` landed on `Ethernet 2`, which turned out to be the **VirtualBox Host-Only Adapter** (`192.168.56.1`).

**Cause:** `detectActiveInterface()` in `src/platform/windows/network.js` picks the first non-virtual interface with an IPv4. Its `VIRTUAL_NAME_HINTS` filter doesn't catch `Ethernet 2` because VirtualBox doesn't include "vbox" / "virtual" in the NIC name on Windows.

**Workaround for this machine:** set `interface_name` explicitly to `"Wi-Fi"` rather than `"auto"`. Or extend `VIRTUAL_NAME_HINTS` to detect VBox host-only by IP (e.g., `192.168.56.0/24`) — separate code change, not done here.

### 3. `netsh interface ip add address` broke internet
**Symptom:** After moving the alias from `Ethernet 2` to `Wi-Fi` with `netsh interface ip add address "Wi-Fi" 192.168.1.50 ...`, internet stopped working on the dev machine.

**Cause:** On a NIC using DHCP, `netsh interface ip add address` **silently switches the NIC to static-IP mode**, pinning the current DHCP-assigned IP as static. Subsequent DHCP renewals / network changes break.

**Recovery:** Reverting the Wi-Fi adapter to "Obtain IP address automatically" in Windows network settings restores DHCP, removes both the static primary IP and the secondary alias.

**Lesson for future:** Never run `netsh interface ip add address` on a Wi-Fi / DHCP NIC. The IP-alias mechanism is designed for permanently-installed machines with static-IP wired Ethernet. On a dev laptop, prefer dev-mode (`node src/index.js`) or skip the alias entirely (agent falls back to binding `0.0.0.0:9100`).

### 4. Same-machine connection got rejected as "non-cashier"
**Symptom:** PowerShell from same machine to `192.168.1.50:9100` got `rejected non-cashier TCP connection {"ip":"192.168.1.50"}`.

**Cause:** Windows uses the destination IP as the source IP when both are local on the same machine. The agent's ACL (`PrintInterceptor._isCashierAllowed`) only accepts loopback or the configured `cashier_ip`. With `cashier_ip: "192.168.1.88"`, the source `192.168.1.50` was rejected.

**Fix:** For same-machine simulation, set `cashier_ip` to the **alias IP itself** (`192.168.1.50`). In a real deployment this isn't needed because the real cashier is on the LAN and arrives with its own real source IP.

**Note:** Trying to force the source IP via `Socket.Bind(192.168.1.88)` and then connecting to `192.168.1.50` resulted in a TCP timeout. Cross-NIC same-host connections with explicit binds behave oddly on Windows. Don't go down this path.

### 5. Order extraction fails for driver-based printing (ERPNext)
**Symptom:** ERPNext print through redirected Windows printer port reached the agent and forwarded to the real printer, but the extracted order number was wrong / nonsense.

**Cause:** Windows print drivers emit **raster / PCL / proprietary command sequences**, not raw ESC/POS text. The Arabic order text the user sees on paper is encoded into bitmap commands; the literal string `رقم الطلب: 42` does not appear in the byte stream, so the regex `رقم الطلب:?\s*(\d+)` matches whatever random digits happen to appear in raster bytes.

**Implication:** The agent's order-extraction mechanism assumes the cashier sends **raw ESC/POS text** (the typical restaurant POS pattern). It does *not* work for general Windows-driver printing.

**Possible future paths:**
- For ERPNext specifically: use a thermal-printer integration that emits raw ESC/POS (e.g., a local helper service driven by ERPNext's print format), pointed at `192.168.1.50:9100`.
- Or: switch the Windows printer to a "Generic / Text Only" driver that produces plain text + minimal ESC/POS instead of raster output. The regex may then match.
- Or: rewrite the extraction layer to OCR the raster bytes — large lift, probably not worth it.

## Architecture clarifications

- **The agent is a TCP middleman for one specific socket** — `bind(printer_old_ip, printer_port)`. It does not hook the Windows print spooler, install a driver, or intercept anything else.
- **In production**: the cashier POS software is hard-configured to print to `printer_old_ip:printer_port`. The agent owns that IP via netsh alias, intercepts, forwards to `printer_new_ip:printer_port`, extracts the order number for the display.
- **The IP alias is the production hijack mechanism** — only safe on machines with static-IP wired Ethernet. Skip it on Wi-Fi/DHCP machines.
- **The order-extraction regex assumes raw ESC/POS text bytes**, which is what restaurant POS software sends. Driver-based Windows printing breaks this assumption.

## State of the dev machine at end of session

- Windows service `QueueManager` installed, RUNNING, autostart on boot
- Files at `C:\ProgramData\QueueManager\`
- Installed config `cashier_ip: 192.168.1.50` (same-machine simulation mode)
- IP alias `192.168.1.50` on `Ethernet 2` (VBox host-only) — does NOT break internet because Wi-Fi is on a separate NIC
- Wi-Fi: `192.168.1.88`, DHCP, internet working
- Cloud connection: failing (local mock cloud at `192.168.1.249:3000` isn't running — unrelated to printing)
- Windows printer's TCP/IP port: redirected to `192.168.1.50` (was `192.168.1.190`) — so ERPNext / any Windows-installed-printer print now goes through the agent
- Repo `config/config.json` and `C:\ProgramData\QueueManager\config\config.json` are out of sync (intentional — installed config has same-machine simulation values)

## To uninstall later

```powershell
cd C:\Users\zmont\OneDrive\Desktop\restaurant\scripts; .\uninstall.bat
```
(needs admin)

This removes the service, firewall rules, and install dir. The IP alias on `Ethernet 2` will also be removed if `uninstall.bat` runs `netsh interface ip delete address`. Verify with `Get-NetIPAddress -IPAddress 192.168.1.50`.

Also consider restoring the Windows printer's TCP/IP port back to `192.168.1.190` after uninstall, otherwise prints will fail (nothing listening on `192.168.1.50` anymore).
