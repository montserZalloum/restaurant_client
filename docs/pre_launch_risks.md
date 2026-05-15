# Pre-Launch Risks — Queue Manager Agent

A working risk register for the first real-restaurant deployment. Captures what we know is broken, what we haven't tested, and what could break the restaurant's day if it does. Built from the 2026-05-12 / 2026-05-13 / 2026-05-14 integration sessions and the 2026-05-14 readiness review.

If something on this list is fixed, **don't delete the entry — annotate it.** The point of a risk register is the audit trail, not the current state.

Last reviewed: 2026-05-14.

---

## A. Known code-level issues (from readiness review)

Status legend: `OPEN` not started · `IN PROGRESS` partial · `FIXED` done · `IGNORED` deliberately out of scope for now.

| # | Issue | Status | Notes |
|---|---|---|---|
| A.1 | Async extractor — verify no sync callsite was missed | FIXED 2026-05-14 | `scripts/smoke-extractor.js` added (`npm run smoke-extractor`); `dist/` rebuilt clean. Both prod callsites (`src/index.js:282`, `src/test-mode.js:274`) await. |
| A.2 | Fail-closed when bundled tessdata is missing | FIXED 2026-05-14 | User reported fixed; mechanism not independently verified in this review. |
| A.3 | OCR regex has no upper digit bound | OPEN | `#\s*(\d{4,})` in `config/config.json:42` and `config/config.skrterak.json:42`. Tighten to `#\s*(\d{4,10})(?!\d)` (10 = real-world max per user). Same shape for `extractor.regex`. Update checklist snippet too. |
| A.4 | `debug.dump_raw_payloads` ships as `true` in field configs | OPEN | `config/config.json` and `config/config.skrterak.json` both `true`. Privacy + unbounded disk. Flip to `false`; consider size cap even when on; boot-time warn when enabled. |
| A.5 | `CERT_NOT_YET_VALID` error has no actionable hint | IGNORED | `src/core/sync/client.js:150-151` logs raw TLS error. Operator can't tell it's a clock-skew issue. Mitigated by checklist §B.1 + memory `feedback_clock_sync_required`. |
| A.6 | Inbound WS path (`settings_updated`) never end-to-end verified | IGNORED | Code exists at `src/core/sync/settings-listener.js`, wired at `src/index.js:265`. Outbound proven, inbound assumed. Means remote config changes from the admin panel are unproven. |
| A.7 | `network.interface_name = "auto"` accepted in production | OPEN | `src/platform/windows/network.js:94-103`. Iteration-order dependent; hint list (`vpn`, `tap`, `tun`) doesn't cover Tailscale / WARP / ZeroTier / RNDIS. Wi-Fi can be picked over Ethernet, then `netsh` clobbers DHCP (memory `feedback_netsh_dhcp_danger`). Recommend reject in schema or fail-closed in `verify-config`. |

## B. Bonus follow-on items (raised but not deeply analyzed)

| # | Issue | Notes |
|---|---|---|
| B.1 | `scripts/test-integration.js` regression after extractor went async | Existed pre-async-change; not re-run. Same callsite-await risk as A.1, different file. |
| B.2 | No regression test for the 2026-05-14 forwarding race | Memory `project_interceptor_forward_race`. The fix lives in `src/core/interceptor/index.js` (`connect` handler flushes `pendingForPrinter` before checking `session.processed`). Easy to break silently in future edits. |
| B.3 | Log rotation | `C:\ProgramData\QueueManager\logs\stdout.log` grows unbounded. Less acute than the captures issue but same eventual disk-fill. |
| B.4 | `setup-helper.js verify-config` rigor | Should catch the "admin panel emits broken config" shapes from checklist §A.1 (e.g., `staff_pin` misnested under `restaurant`). |
| B.5 | NSSM service-recovery aggressiveness unverified | Service is set to auto-start. Restart-on-crash policy / max-retries / restart delay all worth confirming in NSSM config. |

---

## C. Untested at production scale

These are not bugs. They are unknowns. Most of them can only be answered at a real restaurant.

### C.1 Load
- We've done ~12 test prints total across all sessions. A real lunch rush is **30+ orders in 15 minutes**.
- Unknown: OCR worker throughput at that rate (single Tesseract worker, ~500-700ms/recognition, serialized).
- Unknown: staff-page render perf with 50 concurrent active orders.
- Unknown: sync queue back-pressure under sustained burst.

### C.2 OCR misread rate on real receipts
- Current corpus: 7 captures in `tmp/qm-dev/data/captures/`, all the same ERPNext template, all printed by the developer.
- Real receipts have long item names, modifier lines, varying total widths, sometimes mixed Arabic/Latin numerals in the body.
- The ~30% overall confidence number is from one template. **Real misread rate over a week of live orders is unmeasured.**

### C.3 Flaky internet
- Real restaurants drop Wi-Fi for 30-90 seconds many times a day (router reboots, ISP blips, staff microwave).
- Offline queue path is coded but has never been exercised under a multi-hour disconnect.
- WS reconnect storm behavior at recovery is unknown.

### C.4 Power events
- Mid-shift cashier PC restart (Windows Update, power blip).
- Unknown: customer display auto-reconnect cleanliness.
- Unknown: whether in-flight order state survives a hard power loss (the `active_orders.jsonl` flush behavior).
- See B.5 — service-recovery config needs verification.

## D. Untested operational reality

### D.1 Printer pathologies
- Paper jam.
- Out-of-paper.
- Printer reboots itself mid-stream.
- Printer sleep mode (first-byte delay 3+ seconds after long idle — partially responsible for the 2026-05-14 forward race).

We confirmed the printer works. We never tested what the agent does when the printer stops working mid-shift.

### D.2 POS edge cases
- **Reprints** — does ERPNext re-send the identical byte stream? If yes, does the agent emit a duplicate order event? (No dedup logic exists today as far as we know.)
- **Voids / modifications** — does the agent see two prints with the same order number? What ends up on the staff page?
- **Kitchen-only vs customer-receipt** — if ERPNext is configured to print two copies, do we count both as orders?

### D.3 Staff workflow recovery
- Manager marks the wrong order done. How do they un-do it? (Today: no undo. The order leaves the queue.)
- Customer asks "did you get my order?" 10 minutes after it cleared the staff page. The information is gone from the live view.

### D.4 Display placement
- Customer-facing display physical position (sun glare, reading distance, refresh rate, viewing angle).
- Browser zoom level, font readability for elderly customers.
- What it shows during prolonged cloud outage (does it stay live or freeze?).

---

## E. Failure modes — does it affect paper printing?

The agent is an **in-line TCP proxy** in the cashier→printer path. There is no bypass. When the agent fails, paper printing fails.

| Failure | Paper? | Recovery | Notes |
|---|---|---|---|
| Agent process crash / service stopped | **NO paper.** | NSSM auto-restart (~5-30s outage). | Verify NSSM recovery config (B.5). |
| Cashier PC reboot | **NO paper** until boot completes (~1-2 min). | Service auto-start on boot is configured. | |
| Real printer offline (jam / sleep / power) | **NO paper.** | Restore printer. | Worse than pre-agent: POS sees successful TCP send and thinks it printed. Pre-agent the POS would have seen the connect fail. |
| OCR fails on single order | **Paper prints fine.** | Self-recovers next order. | Forward runs before OCR. Order shows on staff page as `method: fallback` with wrong serial. |
| Cloud/WS drops | **Paper prints fine.** | Self-recovers when cloud returns. | Only failure mode that doesn't touch paper. Orders queue locally and re-sync. |
| Agent hangs (deadlock / OOM / GC stall) | **NO paper, indefinitely.** | Requires manual service restart. | NSSM doesn't restart hung processes — only crashed ones. Worst-case mode. See section F.2. |
| 2026-05-14 forwarding race | **NO paper, intermittently.** | Already fixed in code. | No regression test (B.2). Order data still flows to cloud — looks like everything worked except paper. |

## F. What the system has — and doesn't have — to mitigate failures

### Has
- **NSSM auto-restart on crash.** Most agent-side process failures are 5-30 second outages.
- **Decoupled forward path.** Paper printing succeeds even if OCR or cloud sync are broken. The forward to the real printer runs before any extraction or upload.
- **Persistent local queue.** Order events queue to disk during cloud outages and re-sync. No data loss from cloud-side problems.

### Does not have

#### F.1 No bypass / fallback path
There is no "if agent unhealthy for N seconds, route printing directly to the printer." Conceptually possible (Windows printer port could fall over to the real printer IP), but not built.

#### F.2 No watchdog for hangs
NSSM restarts processes that exit non-zero, not processes that are running but stuck. A real hang (OOM, GC stall, deadlock in the Tesseract worker, infinite loop in the interceptor) ties up the printer indefinitely until someone notices.

**Mitigation idea:** periodic self-check that emits a heartbeat or exits the process if the interceptor event loop is unresponsive for N seconds. Then NSSM does the rest.

#### F.3 POS sees no agent failures
From the POS's point of view, "agent accepted bytes" is indistinguishable from "printer printed the page." A partial failure (agent accepts but doesn't forward) is invisible at the POS — no error dialog, no retry. **First signal is a customer asking "where's my food?"**

#### F.4 No rollback runbook
If during a live shift the agent misbehaves and needs to be disabled, the steps are:
1. `Stop-Service QueueManager`
2. `netsh interface ip delete address <interface> <alias_ip>`
3. Reconfigure printer/POS to talk directly (depends on the install — keep notes per-restaurant)

This sequence isn't written down in the repo. **It should be a per-restaurant printed handout taped to the cashier PC** before we leave the site.

#### F.5 No health surface for the manager
The manager has no way to glance at the cashier PC and know "agent is healthy" vs "agent is degraded." Possible UI: systray icon, colored bar on the staff page, dedicated `/health` page on the local HTTP server. Without it, degradation is invisible until paper stops or a customer complains.

---

## G. Pilot / canary plan recommendation

The first restaurant should be treated as a **canary**, not a launch.

- **Pick the lowest-volume slot.** Tuesday lunch, not Friday dinner.
- **Stay on-site.** The installing technician stays at the restaurant or one room away for the first full lunch service. Don't drive home and hope.
- **Print and tape the rollback procedure.** Five steps max. Manager must be able to disable the agent themselves if something breaks outside business hours.
- **Keep `debug.dump_raw_payloads` ON for the first 48 hours** — even though A.4 says off for steady state. During canary phase the corpus is more valuable than the privacy cost. Tell the restaurant. Turn it off at the 48-hour mark.
- **Day-1 close-of-business call to the manager.** "Anything weird today?" Day 3, same. Day 7, same. Then decide if it's stable.
- **Define "stable enough to leave alone" before starting.** Suggested gate: 7 days, zero `method: fallback` orders, zero staff complaints, paper-out-of-sync count < 1 per day. Otherwise the pilot drifts forever.

---

## H. Outstanding actions before any real-restaurant install

Rough priority order, highest first.

1. Close A.3 (OCR regex bound) and A.4 (capture flag default) — both one-line config changes.
2. Resolve A.7 (`interface_name = "auto"`) — at minimum reject in `verify-config`, ideally schema-reject too.
3. Run `scripts/test-integration.js` (B.1) and update it if the async change broke it.
4. Add regression test for the forwarding-race fix (B.2).
5. Verify NSSM service-recovery config (B.5).
6. Add a hang watchdog (F.2) — heartbeat self-check + process exit on stall.
7. Write the per-restaurant rollback runbook (F.4) as a printable template.
8. Decide on a minimal health surface (F.5) — at least a `/health` HTTP endpoint and an Event Viewer log line every N minutes the operator can grep.
9. Run inbound WS test (A.6) against the real cloud — change one safe field in the admin panel, watch the agent log. One-time test, takes 5 minutes once cloud-side is ready.
10. Plan the canary phase per section G before scheduling the install.

---

## Reference

- Session reports: `docs/printer_integration_test_2026-05-12.md`, `docs/cloud_integration_test_2026-05-13.md`, `docs/ocr_integration_test_2026-05-14.md`
- Deployment runbook: `docs/first_restaurant_checklist.md`
- Memories: `feedback_clock_sync_required`, `feedback_netsh_dhcp_danger`, `feedback_no_manipulate_customer_env`, `project_interceptor_forward_race`, `project_ocr_fallback`, `project_agent_intercept_scope`
