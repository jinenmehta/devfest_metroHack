# Every Complaint Heard — PS-07, DevFest Metro Hacks

Offline-first, multilingual complaint triage for metro station controllers.
Sorts a mixed batch of complaints (Gujarati, Hindi, English, Gujlish, Hinglish · app / social / email / paper) into
department queues with an explainable urgency score and a draft reply in the complainant's own language and script.
It runs fully on-device and syncs to HQ when connectivity returns.

## Run (no install, no internet needed)

```bash
node server.js          # Node 18+, zero dependencies
# open http://localhost:8080
npm test                # classifier checks on the 25-complaint sample batch
```

Optional local AI: install Ollama, then run `ollama pull <gemma model>`. Start the server with
`OLLAMA_MODEL=<model> node server.js` (in PowerShell: `$env:OLLAMA_MODEL='<model>'; node server.js`), or type the model name on the **Sync & HQ** tab.
Each complaint then gets a **✨ Refine with local Gemma** button. Without a model, the rule engine does all the work.

## 2-minute demo script

1. **Board → Load sample batch.** 25 complaints in 5 languages are triaged in a few ms. Critical items (smoke, harassment, unattended bag, trapped in lift, injury) appear in the red strip on top.
2. **Click a Gujarati or Hinglish ticket.** Show the urgency breakdown ("why"), the detected language, the station, and the draft reply in the same script. Switch the reply language to show the alternatives.
3. **Tick "Simulate no network"** (or turn off Wi-Fi). Add a complaint on **Add complaints**. It is triaged instantly and the queue counter goes up.
4. **Stop the server** and reload the page. The app still opens from the service-worker cache and keeps triaging.
5. **Restart the server and untick offline.** The outbox auto-syncs. **Sync & HQ** shows the records at HQ.
6. **Re-route a ticket** to another department. The device learns from the correction for future complaints.

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
server.js              static server + /api/sync, /api/hq, /api/llm (Ollama proxy)
public/classifier.js   triage engine (language, department, urgency, station, replies, learning)
public/app.js          UI, storage, outbox sync, local-LLM refinement
public/samples.js      25 synthetic multilingual complaints
public/sw.js           offline app-shell cache
test/                  classifier checks
```
