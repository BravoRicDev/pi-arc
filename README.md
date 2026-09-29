# pi-arc — Addressable Recall Compaction

Lossless context compression via ID-addressable archive, implementing the technique described in
["Addressable Recall Compaction for Long Context-Window Control in AI Agents"](https://arxiv.org/abs/2607.25066).

**English** · [Italiano](#italiano) · Companion extension: [pi-cwl](https://github.com/BravoRicDev/pi-cwl)

---

## English

### The problem

Large tool outputs (grep, glob, search, massive file reads) saturate the agent context window
quickly. Traditional compaction either destroys them or truncates them irreversibly — the agent
cannot recover the original data without re-running the tool.

### What this extension does

ARC adopts a lossless, OS-inspired approach:

1. **Append-only, ID-addressable archive.** Every tool output exceeding a minimum size is written
   immutably to `~/.pi/arc/archive/<id>.json`.
2. **Compact citations in context.** The bulky tool output is replaced by a structured, lightweight
   citation: `[ARC id=<id> tokens=<n> summary="..."]`.
3. **On-demand recall.** If the agent needs the full detail, it calls `arc_recall(id)` — no
   re-execution required.

### Advantages

- **99.4% Needle-in-a-Haystack accuracy** (as reported in the paper).
- **Zero data loss.** Original content is never deleted, only moved out of the primary active
  context.
- **Drastic context-pressure reduction** without relying on imperfect LLM-generated summaries.

### Tools

**`arc_recall`** — retrieve the full original tool output by its ARC ID.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | — | 12-char hex ID from the citation |
| `full` | `boolean` | `true` | `false` returns a 500-char preview |

**`arc_status`** — archive entry count, total archived tokens, active citations in context.

**`arc_purge`** — remove archive entries older than N days (default 30). **Never** touches entries
still cited in the active context.

### Installation

Pi loads the extension from `index.ts` at the repository root. Link or copy into your Pi
extensions directory:

```
~/.pi/agent/extensions/pi-arc  ->  <this repository>
```

### Configuration

Optional, at `~/.pi/arc/config.json`:

```json
{
  "tokenBudget": 80000,
  "thresholdRatio": 0.85,
  "maxArchiveEntryBytes": 500000,
  "minArchiveBytes": 5000,
  "showWidget": true,
  "debug": false
}
```

- `tokenBudget` / `thresholdRatio` — citation trigger at `tokenBudget × thresholdRatio`.
- `maxArchiveEntryBytes` — hard cap per entry (prevents runaway disk usage).
- `minArchiveBytes` — outputs smaller than this stay inline.

Missing keys fall back to defaults.

### Attribution

This is an **original, independent implementation** written in TypeScript for the Pi agent
ecosystem. It contains no code copied, forked or adapted from any third-party repository.

- **Paper:** "Addressable Recall Compaction for Long Context-Window Control in AI Agents"
  — Thang Dang, Yuma Ichikawa, Sakina Fatima, Koichi Shirahata (2026),
  [arXiv:2607.25066](https://arxiv.org/abs/2607.25066)
- The ARC concept originates with the paper authors; this implementation is ours.
- See `CITATION.cff` for formal citation and `LICENSE` for terms.

---

## Italiano

### Il problema

Output di tool di grandi dimensioni (grep, glob, search, letture di file massicci) saturano
rapidamente la finestra di contesto dell'agente. La compattazione tradizionale li distrugge o li
tronca in modo irreversibile — l'agente non può recuperare l'originale senza rieseguire il tool.

### Cosa fa questa estensione

ARC adotta un approccio lossless ispirato ai sistemi operativi:

1. **Archivio append-only ID-addressable.** Ogni tool output che supera la soglia minima viene
   salvato in modo immutabile in `~/.pi/arc/archive/<id>.json`.
2. **Citazioni compatte nel contesto.** L'output voluminoso viene sostituito da una citazione
   strutturata e leggera: `[ARC id=<id> tokens=<n> summary="..."]`.
3. **Recupero on-demand.** Se l'agente ha bisogno del dettaglio completo, chiama `arc_recall(id)`
   — senza rieseguire il comando.

### Vantaggi

- **Accuracy Needle-in-a-Haystack al 99.4%** (come riportato nel paper).
- **Zero perdite di dati.** Il contenuto originale non viene mai cancellato, solo spostato fuori
  dal contesto attivo primario.
- **Riduzione drastica della pressione di contesto** senza ricorrere a riassunti imperfetti
  generati dall'LLM.

### Tool

**`arc_recall`** — recupera il contenuto originale di un tool output archiviato tramite il suo ID
ARC.

| Parametro | Tipo | Default | Note |
|---|---|---|---|
| `id` | `string` | — | ID esadecimale a 12 caratteri dalla citazione |
| `full` | `boolean` | `true` | `false` restituisce un'anteprima di 500 caratteri |

**`arc_status`** — conteggio entry archivio, token archiviati totali, citazioni attive nel contesto.

**`arc_purge`** — rimuove entry dell'archivio più vecchie di N giorni (default 30). **Non tocca**
mai entry ancora citate nel contesto attivo.

### Installazione

Pi carica l'estensione da `index.ts` nella root del repository. Collega o copia l'estensione nella
directory delle estensioni di Pi:

```
~/.pi/agent/extensions/pi-arc  ->  <questo repository>
```

### Configurazione

Opzionale, in `~/.pi/arc/config.json`:

```json
{
  "tokenBudget": 80000,
  "thresholdRatio": 0.85,
  "maxArchiveEntryBytes": 500000,
  "minArchiveBytes": 5000,
  "showWidget": true,
  "debug": false
}
```

- `tokenBudget` / `thresholdRatio` — la citazione scatta a `tokenBudget × thresholdRatio`.
- `maxArchiveEntryBytes` — tetto massimo per entry (previene uso disco incontrollato).
- `minArchiveBytes` — output più piccoli restano inline.

Le chiavi mancanti ricadono sui valori di default.

### Attribuzione

Questa è un'**implementazione originale e indipendente**, scritta in TypeScript per l'ecosistema Pi
Agent. Non contiene codice copiato, forkato o adattato da alcun repository di terze parti.

- **Paper:** "Addressable Recall Compaction for Long Context-Window Control in AI Agents"
  — Thang Dang, Yuma Ichikawa, Sakina Fatima, Koichi Shirahata (2026),
  [arXiv:2607.25066](https://arxiv.org/abs/2607.25066)
- Il concetto di ARC origina dagli autori del paper; questa implementazione è nostra.
- Vedi `CITATION.cff` per la citazione formale e `LICENSE` per i termini.