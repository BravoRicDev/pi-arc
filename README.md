# ARC (Addressable Recall Compaction)

Lossless context compression via ID-addressable archive, based on arXiv:2607.25066.

## Panoramica
I tool output di grandi dimensioni (grep, glob, search, letture di file massicci) saturano rapidamente il contesto dell'agente. Le tecniche di compattazione tradizionali li distruggono o li troncano in modo irreversibile.

**ARC** adotta un approccio lossless ispirato ai sistemi operativi:
1. **Archivio Append-Only ID-Addressable:** Ogni tool output che supera la soglia minima viene salvato in modo immutabile in `~/.pi/arc/archive/<id>.json`.
2. **Citazioni Compatte nel Contesto:** Nel contesto attivo, il tool output voluminoso viene sostituito da una citazione strutturata e leggera: `[ARC id=<id> tokens=<n> summary="..."]`.
3. **Recupero On-Demand:** Se l'agente ha bisogno del dettaglio completo di un tool output passato, richiama il tool `arc_recall(id)` senza dover rieseguire il comando.

---

## Vantaggi
- **Accuracy Needle-in-a-Haystack al 99.4%** (come dimostrato nel paper di riferimento).
- **Zero perdite di dati:** Il contenuto originale non viene mai perso, ma semplicemente spostato fuori dal contesto attivo primario.
- **Riduzione drastica della pressione di contesto** senza ricorrere a riassunti imperfetti generati dall'LLM.

---

## Crediti e Riconoscimenti
Questo progetto è un'implementazione indipendente e originale di:
- **Paper:** "Addressable Recall Compaction for Long Context-Window Control in AI Agents" (arXiv:2607.25066)
- **Autori del Paper:** Thang Dang, Yuma Ichikawa, Sakina Fatima, Koichi Shirahata (2026)

Il concetto e il design di ARC appartengono agli autori del paper. Questa estensione è stata progettata e scritta da zero in TypeScript per integrarsi nativamente con l'ecosistema Pi Agent. Non contiene codice di terze parti o derivato da repository degli autori.

Per citare formalmente questo lavoro, fai riferimento al file `CITATION.cff`.

---

## Installazione e Configurazione
L'estensione si attiva automaticamente tramite symlink in `~/.pi/agent/extensions/pi-arc`.

### Configurazione (`~/.pi/arc/config.json`)
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

---

## Tool Disponibili
1. **`arc_recall`**: Recupera il contenuto integrale di un tool output archiviato tramite il suo ID.
   - `id`: ID a 12 caratteri esadecimali della citazione.
   - `full`: Boolean (default `true`).
2. **`arc_status`**: Mostra lo stato dell'archivio, il numero di entry e i token risparmiati nel contesto attivo.
3. **`arc_purge`**: Pulisce le entry dell'archivio più vecchie di N giorni (default 30), senza toccare il contesto attivo.
