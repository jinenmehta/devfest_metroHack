# Sunvai Grievance Desk

*Built for DevFest Metro Hacks PS-07, "Every Complaint Heard".*

Sunvai is a passenger grievance desk for metro station controllers. It has a dashboard, department inboxes, complaint detail with a reply composer and activity log, import and export, and settings.
Offline-first, multilingual complaint triage.
Sorts a mixed batch of complaints (Gujarati, Hindi, English, Gujlish, Hinglish · app / social / email / paper) into
department queues with an explainable urgency score and a draft reply in the complainant's own language and script.
It runs fully on-device and syncs to HQ when connectivity returns.

## Run (no install, no internet needed)

```bash
node server.js          # Node 18+, zero dependencies
# open http://localhost:8080
npm test                # classifier checks on the 25-complaint sample batch
```

### Control centre console

Open **http://localhost:8080/admin**. The default password is `admin123`; change it with the `ADMIN_PASSWORD` environment variable (`$env:ADMIN_PASSWORD='…'; node server.js`).

| Page | What the admin can do |
|---|---|
| Network overview | See active, critical, overdue, escalated and resolved-today totals across all stations, a station risk table, department load and device status |
| All complaints | Filter by station, department, urgency and status, search and export to CSV. Open a complaint to **re-route** it, **change its status**, **escalate** it, or **send an instruction or note** to the station |
| Escalations | Active complaints under control-centre watch |
| Stations & devices | Every station desk: controller, online / idle / offline, last sync, workload |
| Policy & routing | Set the **response targets** per urgency level and **extra routing keywords** per department, test routing live, then publish. Devices apply the policy on their next sync and keep it for offline use |
| Audit log | Sign-ins, admin actions, policy changes and device uploads |

Sync works in both directions. Stations push their complaints, and the control centre's edits and policy come back in the same request. A device that was offline merges control-centre notes and escalations without losing its own changes.

Optional local AI: install Ollama, then run `ollama pull <gemma model>`. Start the server with
`OLLAMA_MODEL=<model> node server.js` (in PowerShell: `$env:OLLAMA_MODEL='<model>'; node server.js`), or type the model name on the **Sync & HQ** tab.
Each complaint then gets a **✨ Refine with local Gemma** button. Without a model, the rule engine does all the work.

## 2-minute demo script

1. **First launch:** enter your name and station. Then go to **Settings → Load demo data**. The dashboard fills with 25 complaints in 5 languages, and the critical ones appear under "Needs attention".
2. **Open a Gujarati or Hinglish complaint** in the inbox. Show the urgency breakdown, the detected language and station, and the reply drafted in the same script. Change the reply language to show the other options.
3. **Acknowledge** the complaint, **add a note**, **mark the reply as sent**, then **resolve** it. Each step appears in the activity timeline.
4. Go to **Settings → Work offline** (or turn off Wi-Fi). Create a **New complaint**: the live assessment updates as you type, and the top bar shows "Offline · N pending".
5. **Stop the server** and reload the page. The app still opens from the service-worker cache.
6. **Restart the server and switch offline mode off.** Pending updates sync automatically.
7. **Move a complaint to another department.** The device learns from the correction for similar complaints.

## Design notes

| Concern | Approach |
|---|---|
| Language | Unicode-block detection (Gujarati / Devanagari) plus marker-word scoring for romanized Gujlish and Hinglish |
| Routing | Weighted multilingual lexicons for 5 required departments plus General, with confidence and a "review" flag below 50% |
| Urgency | Department base score plus explainable signals (life-safety, vulnerable passenger, immediacy, recurrence, money lost, public post, corroboration). Levels: Critical ≥75 · High ≥55 · Medium ≥35 · Low, with SLAs of 15 min / 4 h / 24 h / 72 h |
| Replies | Templates in 5 languages and scripts, carrying the reference number and SLA. Optional Gemma rewrite |
| Offline | Service worker app shell, localStorage data, and an outbox of `id → updatedAt` |
| Sync | Idempotent POST `/api/sync`, last-write-wins on `updatedAt`. Retries on reconnect and every 15 s |
| Learning | Controller corrections add per-device token→department weights |

**Data:** the sample complaints in `public/samples.js` are synthetic, because no datasets are provided at the event. Station names are real Ahmedabad–Gandhinagar Metro stations. The "time saved" figure assumes about 3 minutes of manual reading and routing per complaint.

**PPP:** the operator owns the data, the SLAs and the HQ server, and pays a per-station licence. A private partner builds and maintains the app, the lexicons and the local model. The partner can resell the engine to other metro and bus operators under a revenue share.

## Files

```
server.js              static server + /api/sync (two-way), /api/config, /api/admin/*, /api/llm (Ollama proxy)
public/admin.html/.js  control centre console
public/classifier.js   triage engine (language, department, urgency, station, replies, learning)
public/app.js          UI, storage, outbox sync, local-LLM refinement
public/samples.js      25 synthetic multilingual complaints
public/sw.js           offline app-shell cache
test/                  classifier checks
```
