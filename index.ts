/**
 * ARC — Addressable Recall Compaction
 * Lossless context compression via ID-addressable archive.
 *
 * PROBLEMA
 *   I tool output grandi (grep, glob, search, read) riempiono il
 *   contesto e vengono persi dopo la compattazione. L'agente non
 *   puo' recuperarli senza ri-eseguire il tool.
 *
 * SOLUZIONE (https://arxiv.org/abs/2607.25066)
 *   1. Ogni tool output viene scritto in un log append-only
 *      ID-addressabile (~/.pi/arc/archive/<id>.json).
 *   2. Nel contesto attivo, il tool output viene sostituito da
 *      una citazione compatta: "[ARC id=<id> tokens=<n> summary=<...>]"
 *   3. The agent can request the original content via
 *      tool arc_recall(id) senza ri-eseguire il tool.
 *   4. Separazione netta: archivio (completo) vs contesto attivo (compresso).
 *
 *   Il log e' append-only: mai sovrascrittura, mai cancellazione.
 *   Le citazioni sono reversibili in qualsiasi momento.
 *
 * FORMA REALE DEI MESSAGGI (da @earendil-works/pi-ai)
 *   ToolResultMessage: { role: "toolResult", content: (Text|Image)[], toolCallId, toolName }
 *   Nota: il role dei tool result e' "toolResult", NON "tool".
 *   content e' un array di blocchi, NON una stringa.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Tipi minimi della forma reale dei messaggi (sottoset di @earendil-works/pi-ai)
// ---------------------------------------------------------------------------

interface RealContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface RealMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  /** Id of the archive entry this message's content was replaced by. */
  _arcId?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ArcConfig {
  /** Massimo token nel contesto attivo prima di attivare le citazioni. */
  tokenBudget: number;
  /** Soglia: quando il contesto supera tokenBudget * thresholdRatio, si attiva. */
  thresholdRatio: number;
  /** Dimensione massima di un singolo entry nell'archivio (bytes). */
  maxArchiveEntryBytes: number;
  /** Tool output piu' piccolo di questo non viene archiviato (bytes). */
  minArchiveBytes: number;
  /**
   * Tetto sul TOTALE dell'archivio. L'archivio e' append-only e la purge e'
   * solo per eta' e manuale: senza questo, un'installazione a lungo termine
   * accumula GB (ogni entry puo' arrivare a maxArchiveEntryBytes).
   */
  maxArchiveTotalBytes: number;
  /** Mostra widget UI. */
  showWidget: boolean;
  /** Log di debug. */
  debug: boolean;
}

const DEFAULT_CONFIG: ArcConfig = {
  tokenBudget: 80_000,
  thresholdRatio: 0.85,
  maxArchiveEntryBytes: 500_000,
  minArchiveBytes: 5_000,
  maxArchiveTotalBytes: 200_000_000, // ~200 MB
  showWidget: true,
  debug: false,
};

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

type Lang = 'en' | 'it';

const FALLBACK: Lang = 'en';

function primaryOf(tag: string): string | null {
  if (typeof tag !== 'string') return null;
  // Same regex as pi-anti-amnesia/i18n.mjs, pi-cwl and pi-cron-bg: a naive
  // split on "." yields "it_it" for "it_IT.UTF-8", which is not supported.
  const m = /^\s*([A-Za-z]{2,3})(?:-|_)/.exec(tag) ?? /^\s*([A-Za-z]{2,3})\s*$/.exec(tag);
  return m ? m[1].toLowerCase() : null;
}

function isSupported(primary: string | null): primary is Lang {
  return primary === 'en' || primary === 'it';
}

/**
 * Resolves the system language once, at module load.
 * Must stay in lockstep with the other extensions: they all inject
 * instructions into the same model context, and mixed-language directives
 * degrade the model.
 */
function detectLang(): Lang {
  const env = process.env;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const tag = env?.[name];
    if (!tag || tag === 'C' || tag === 'POSIX') continue;
    const primary = primaryOf(tag);
    if (isSupported(primary)) return primary;
  }
  try {
    const icu = primaryOf(Intl.DateTimeFormat().resolvedOptions().locale ?? '');
    if (isSupported(icu)) return icu;
  } catch { /* no ICU data */ }
  return FALLBACK;
}

const LANG: Lang = detectLang();

type ArcMessages = {
  entryNotFound: (id: string) => string;
  recallTruncated: string;
  purgeDone: (purged: number, days: number) => string;
  purgeNothing: string;
};

const I18N: Record<Lang, ArcMessages> = {
  en: {
    entryNotFound: (id) => `ARC entry "${id}" not found in the archive.`,
    recallTruncated: '… (truncated, use full=true for the complete content)',
    purgeDone: (purged, days) => `ARC purge: removed ${purged} entries older than ${days}d.`,
    purgeNothing: 'No orphan entry to remove.',
  },
  it: {
    entryNotFound: (id) => `Entry ARC "${id}" non trovato nell'archivio.`,
    recallTruncated: '… (troncato, usa full=true per il contenuto completo)',
    purgeDone: (purged, days) => `ARC purge: rimosse ${purged} entry piu' vecchie di ${days}gg.`,
    purgeNothing: 'Nessun job orfano da rimuovere.',
  },
} satisfies Record<Lang, ArcMessages>;

/** Localised string for the active language. */
function t<K extends keyof ArcMessages>(key: K): ArcMessages[K] {
  return I18N[LANG][key];
}

// Config utente: ~/.pi/arc/config.json. Se assente si cade sul config incluso
// nell'estensione, cosi' il file distribuito col repo serve davvero a qualcosa
// invece di restare un documento morto.
const _EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(os.homedir(), '.pi', 'arc', 'config.json');
const BUNDLED_CONFIG_PATH = path.join(_EXT_DIR, 'config.json');
const ARCHIVE_DIR = path.join(os.homedir(), '.pi', 'arc', 'archive');
const LOG_PATH = path.join(os.homedir(), '.pi', 'arc', 'arc.log');

function loadConfig(): ArcConfig {
  for (const candidate of [CONFIG_PATH, BUNDLED_CONFIG_PATH]) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<ArcConfig> };
    } catch {
      // prova il candidato successivo
    }
  }
  return { ...DEFAULT_CONFIG };
}

function debugLog(cfg: ArcConfig, msg: string) {
  if (!cfg.debug) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* non critico */ }
}

// ---------------------------------------------------------------------------
// Archive store (append-only, ID-addressable)
// ---------------------------------------------------------------------------

interface ArchiveEntry {
  id: string;
  toolCallId: string;
  toolName: string;
  contentHash: string;
  tokenEstimate: number;
  sizeBytes: number;
  summary: string;
  timestamp: number;
  /** Contenuto originale (preservato verbatim). */
  content: string;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(): string {
  return randomUUID().slice(0, 12);
}

function ensureArchiveDir() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

/**
 * Write with atomic rename to avoid partial writes (race condition fix).
 * POSIX rename is atomic on the same filesystem.
 */
function storeEntry(entry: ArchiveEntry): string {
  ensureArchiveDir();
  const tmpPath = path.join(ARCHIVE_DIR, `.${entry.id}.tmp`);
  const finalPath = path.join(ARCHIVE_DIR, `${entry.id}.json`);
  // Write to temp file first, then atomic rename.
  fs.writeFileSync(tmpPath, JSON.stringify(entry));
  fs.renameSync(tmpPath, finalPath);
  // Keep the derived caches coherent. Without this, diskIndex() keeps serving
  // the snapshot it took before this write, so the next session (whose in-memory
  // hashToId starts empty) misses the entry and archives a duplicate.
  _listCache = null;
  if (_diskIndex) {
    if (!_diskIndex.has(entry.contentHash)) _diskIndex.set(entry.contentHash, entry.id);
  }
  return entry.id;
}

function loadEntry(id: string): ArchiveEntry | null {
  const filePath = path.join(ARCHIVE_DIR, `${id}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as ArchiveEntry;
  } catch {
    return null;
  }
}

/**
 * Cached listing: reads from disk only when the directory mtime changes.
 * Avoids O(n) file reads on every call.
 */
let _listCache: { entries: ArchiveEntry[]; mtime: number; dir: string } | null = null;

function listEntries(): ArchiveEntry[] {
  ensureArchiveDir();
  try {
    const dirStat = fs.statSync(ARCHIVE_DIR);
    const currentMtime = dirStat.mtimeMs;
    if (_listCache && _listCache.mtime === currentMtime && _listCache.dir === ARCHIVE_DIR) {
      return _listCache.entries;
    }
    const entries = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')) as ArchiveEntry; }
        catch { return null; }
      })
      .filter((e): e is ArchiveEntry => e !== null);
    _listCache = { entries, mtime: currentMtime, dir: ARCHIVE_DIR };
    return entries;
  } catch {
    return [];
  }
}

function invalidateListCache() {
  _listCache = null;
  _diskIndex = null;
}

/**
 * Keeps the archive under cfg.maxArchiveTotalBytes by dropping the OLDEST
 * entries first. Entries cited in the active context are never removed: that
 * would break arc_recall on a citation the model is still looking at.
 *
 * Runs after a store, so the newly written entry is the newest and therefore
 * the last candidate for eviction.
 */
function enforceArchiveCap(cfg: ArcConfig, state: ArcState): number {
  const entries = listEntries();
  let total = 0;
  for (const e of entries) total += (e?.sizeBytes ?? 0);
  if (total <= cfg.maxArchiveTotalBytes) return 0;

  const byAge = [...entries].sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
  let removed = 0;
  for (const e of byAge) {
    if (total <= cfg.maxArchiveTotalBytes) break;
    if (!e || state.activeCitations.has(e.id)) continue;
    try {
      fs.unlinkSync(path.join(ARCHIVE_DIR, `${e.id}.json`));
      total -= (e.sizeBytes ?? 0);
      state.hashToId.delete(e.contentHash);
      state.transformedHashes.delete(e.contentHash);
      removed++;
    } catch { /* ignore: another process may have removed it first */ }
  }
  if (removed > 0) invalidateListCache();
  return removed;
}

// ---------------------------------------------------------------------------
// Disk index (contentHash -> id)
//
// The per-session hashToId Map starts empty on every session_start, so without
// this a tool output already archived by an earlier session would be stored a
// second time under a fresh id. Re-reading the same file is routine, which
// makes archive duplication the normal case rather than an edge case.
// Built lazily on first miss, cached until the archive directory changes.
// ---------------------------------------------------------------------------

let _diskIndex: Map<string, string> | null = null;

function diskIndex(): Map<string, string> {
  if (_diskIndex) return _diskIndex;
  const idx = new Map<string, string>();
  for (const e of listEntries()) {
    if (e && typeof e.contentHash === 'string' && e.id) {
      // First writer wins: the oldest id stays canonical.
      if (!idx.has(e.contentHash)) idx.set(e.contentHash, e.id);
    }
  }
  _diskIndex = idx;
  return idx;
}

// ---------------------------------------------------------------------------
// Session state (per session: avoids collisions with subagents)
// ---------------------------------------------------------------------------

interface ArcState {
  /** Map id -> entry per gli entry nel contesto attivo. */
  activeCitations: Map<string, ArchiveEntry>;
  /** Indice inverso: contentHash -> id per lookup O(1). */
  hashToId: Map<string, string>;
  /** Totale token archiviati. */
  totalArchivedTokens: number;
  /** Numero totale di entry nell'archivio. */
  totalEntries: number;
  /** Hash dei messaggi trasformati in citazioni (con limite per evitare memory leak). */
  transformedHashes: Map<string, number>; // hash -> timestamp
}

function newArcState(): ArcState {
  return {
    activeCitations: new Map(),
    hashToId: new Map(),
    totalArchivedTokens: 0,
    totalEntries: 0,
    transformedHashes: new Map(),
  };
}

/** Chiave di sessione: cwd + path sessione se disponibile, altrimenti "default". */
function sessionKey(ctx: ExtensionContext | null | undefined): string {
  try {
    const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : '';
    const sm = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } })?.sessionManager;
    const sid = typeof sm?.getSessionId === 'function' ? sm.getSessionId() : '';
    return `${cwd}::${sid}`;
  } catch {
    return 'default';
  }
}

const states = new Map<string, ArcState>();
const configs = new Map<string, ArcConfig>();

function getState(key: string): ArcState {
  let st = states.get(key);
  if (!st) { st = newArcState(); states.set(key, st); }
  return st;
}

function getConfig(key: string): ArcConfig {
  let cf = configs.get(key);
  if (!cf) { cf = loadConfig(); configs.set(key, cf); }
  return cf;
}

function dropState(key: string) {
  states.delete(key);
  configs.delete(key);
}

// ---------------------------------------------------------------------------
// Citation builder
// ---------------------------------------------------------------------------

function buildCitation(entry: ArchiveEntry): string {
  const preview = entry.content.slice(0, 200).replace(/\n/g, ' ');
  return `[ARC id=${entry.id} tokens=${entry.tokenEstimate} hash=${entry.contentHash} summary="${entry.summary}" preview="${preview}…"]`;
}

function summarizeContent(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 5) return content.slice(0, 100);
  return `${lines[0].slice(0, 80)} … (${lines.length} righe, ${content.length} chars) … ${lines[lines.length - 1].slice(0, 60)}`;
}

// ---------------------------------------------------------------------------
// Context transformer (hook 'context')
// ---------------------------------------------------------------------------

/**
 * Intercetta i messaggi in ingresso al modello.
 * Sostituisce tool output grandi con citazioni ARC.
 *
 * FIX CRITICO: il role dei tool result e' "toolResult" (non "tool"),
 * e content e' un array (non una stringa).
 */
function transformContext(
  cfg: ArcConfig,
  state: ArcState,
  messages: AgentMessage[],
): { messages: AgentMessage[]; citations: string[] } {
  const citations: string[] = [];
  const transformed: AgentMessage[] = [];

  // Refresh activeCitations against the context we are actually looking at.
  // It used to be append-only, so every entry ever archived stayed "active"
  // and enforceArchiveCap() could never evict anything: the cap was inert.
  // Citations only live as long as the message carrying them, so prune here.
  const liveIds = new Set<string>();
  for (const m of messages) {
    const r = (m as unknown as RealMessage);
    if (r && r._arcId) liveIds.add(r._arcId);
  }
  if (liveIds.size > 0 || state.activeCitations.size > 0) {
    for (const id of [...state.activeCitations.keys()]) {
      if (!liveIds.has(id)) state.activeCitations.delete(id);
    }
  }

  for (const msg of messages) {
    const m = msg as unknown as RealMessage;

    // FIX #1: il role reale e' "toolResult", NON "tool"
    if (m.role !== 'toolResult') {
      transformed.push(msg);
      continue;
    }

    // content e' un array di blocchi (TextContent | ImageContent)
    const contentArr = m.content;
    if (!Array.isArray(contentArr)) {
      transformed.push(msg);
      continue;
    }

    // Concatena tutto il testo per stimare dimensione e hash
    const fullText = contentArr
      .filter((b): b is RealContentBlock => b && typeof b === 'object')
      .map(b => b.text ?? b.data ?? '')
      .join('\n');

    // Content is measured in bytes, not UTF-16 code units: an Italian or
    // emoji-heavy tool output is up to 3-4x larger than .length suggests, so
    // comparing .length against a "*Bytes" threshold let oversized payloads
    // through. Measure once, reuse for both limits.
    const sizeBytes = new TextEncoder().encode(fullText).length;
    if (sizeBytes < cfg.minArchiveBytes) {
      transformed.push(msg);
      continue;
    }
    // FIX #5: rispetta maxArchiveEntryBytes
    if (sizeBytes > cfg.maxArchiveEntryBytes) {
      // Entry too large: skip archiving, leave the original content in place.
      transformed.push(msg);
      continue;
    }

    const h = contentHash(fullText);

    // FIX #3: de-dup — emit the CITATION, never the original content
    // Look up the memory index first, then the on-disk index: the per-session
    // map starts empty, so without the disk fallback every re-read of the same
    // file in a new session would write a duplicate archive entry.
    const existingId = state.hashToId.get(h) ?? diskIndex().get(h);
    let entry: ArchiveEntry | undefined;
    if (existingId) {
      entry = state.activeCitations.get(existingId);
      if (!entry) entry = loadEntry(existingId) ?? undefined;
    }

    if (!entry) {
      // Not in memory and not on disk (or purged in between): store it now.
      const id = generateId();
      entry = {
        id,
        toolCallId: m.toolCallId ?? '',
        toolName: m.toolName ?? 'unknown',
        contentHash: h,
        tokenEstimate: estimateTokens(fullText),
        sizeBytes,
        summary: summarizeContent(fullText),
        timestamp: Date.now(),
        content: fullText,
      };
      storeEntry(entry);
      state.activeCitations.set(id, entry);
      state.totalArchivedTokens += entry.tokenEstimate;
      state.totalEntries++;
      // Keep the archive bounded: without this it grows without limit, because
      // the only reducer is a manual age-based purge.
      enforceArchiveCap(cfg, state);
    }

    // Adopt the resolved id for this session, so the next hook is a memory hit.
    state.hashToId.set(h, entry.id);
    // Keep the in-memory registry bounded (cap 10000) to avoid a slow leak in
    // long sessions. Evicting the oldest half is safe: a miss only costs a
    // diskIndex() lookup.
    state.transformedHashes.set(h, Date.now());
    if (state.transformedHashes.size > 10_000) {
      const sorted = [...state.transformedHashes.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = Math.floor(sorted.length / 2);
      for (let i = 0; i < toRemove; i++) {
        state.transformedHashes.delete(sorted[i][0]);
      }
    }

    citations.push(entry.id);
    const citation = buildCitation(entry);
    transformed.push({
      ...m,
      content: [{ type: 'text', text: citation }],
      _arcCitation: true,
      _arcId: entry.id,
    } as unknown as AgentMessage);
  }

  return { messages: transformed, citations };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- Tools -------------------------------------------------------------

  pi.registerTool({
    name: 'arc_recall',
    label: 'ARC Recall',
    description:
      'Recupera il contenuto originale di un tool output archiviato ' +
      'tramite il suo ID ARC. Usa quando hai bisogno del dettaglio ' +
      'completo che era stato compattato in una citazione.',
    promptSnippet: 'arc_recall: recupera tool output archiviato per ID',
    parameters: Type.Object({
      id: Type.String({ description: 'ID ARC dell\'entry da recuperare (es. "a1b2c3d4e5f6").' }),
      full: Type.Optional(Type.Boolean({ description: 'Restituisce il contenuto completo (default true).' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // arc_recall reads straight from disk by id, so it needs no session state.
      const entry = loadEntry(params.id);
      if (!entry) {
        return {
          content: [{ type: 'text', text: t('entryNotFound')(params.id) }],
          details: { ok: false, error: 'entry-not-found' },
        };
      }

      // FIX #4: onora il parametro 'full'
      const full = params.full ?? true;
      const preview = full ? entry.content : entry.content.slice(0, 500);
      const truncated = full ? '' : (entry.content.length > 500 ? t('recallTruncated') : '');

      return {
        content: [{ type: 'text', text: `ARC ${entry.id} [${entry.toolName}, ${entry.tokenEstimate} tokens]:\n${preview}${truncated}` }],
        details: { ok: true, id: entry.id, toolName: entry.toolName, tokenEstimate: entry.tokenEstimate, sizeBytes: entry.sizeBytes },
      };
    },
  });

  pi.registerTool({
    name: 'arc_status',
    label: 'ARC Status',
    description: 'Mostra lo stato dell\'archivio ARC: entry, token archiviati, citazioni attive.',
    promptSnippet: 'arc_status: stato archivio ARC',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const st = getState(key);
      const cf = getConfig(key);
      const entries = listEntries();
      const lines = [
        `ARC — token budget: ${cf.tokenBudget.toLocaleString()} (threshold: ${(cf.thresholdRatio * 100).toFixed(0)}%)`,
        `Entry totali archivio: ${entries.length} | token archiviati: ${st.totalArchivedTokens.toLocaleString()}`,
        `Citazioni attive nel contesto: ${st.activeCitations.size}`,
      ];
      if (entries.length > 0) {
        lines.push('Entry recenti:');
        for (const e of entries.slice(-10)) {
          lines.push(`  ${e.id} ${e.toolName} ${e.tokenEstimate}t ${e.sizeBytes}b ${new Date(e.timestamp).toISOString()}`);
        }
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          ok: true,
          totalEntries: entries.length,
          totalArchivedTokens: st.totalArchivedTokens,
          activeCitations: st.activeCitations.size,
        },
      };
    },
  });

  pi.registerTool({
    name: 'arc_purge',
    label: 'ARC Purge',
    description: 'Purges archived entries older than N days. Does NOT touch the active context.',
    promptSnippet: 'arc_purge: pulisci archivio ARC vecchio',
    parameters: Type.Object({
      daysOlder: Type.Optional(Type.Number({ description: 'Remove entries older than N days (default 30).' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKey(ctx);
      const st = getState(key);
      const days = params.daysOlder ?? 30;
      const cutoff = Date.now() - days * 86400000;
      const entries = listEntries();
      let purged = 0;
      for (const e of entries) {
        // FIX #8: non cancellare entry ancora citate nel contesto attivo
        if (e.timestamp < cutoff && !st.activeCitations.has(e.id)) {
          try {
            fs.unlinkSync(path.join(ARCHIVE_DIR, `${e.id}.json`));
            // Also drop it from the current session's hashToId index
            st.hashToId.delete(e.contentHash);
            st.activeCitations.delete(e.id);
            st.transformedHashes.delete(e.contentHash);
            purged++;
          } catch { /* ignore */ }
        }
      }
      invalidateListCache();
      return {
        content: [{ type: 'text', text: t('purgeDone')(purged, days) }],
        details: { ok: true, purged, days },
      };
    },
  });

  // ---- Hooks -------------------------------------------------------------

  pi.on('session_start', async (_event, ctx) => {
    const key = sessionKey(ctx);
    states.set(key, newArcState());
    configs.set(key, loadConfig());
    debugLog(getConfig(key), 'SESSION START — ARC state reset');
  });

  pi.on('context', async (event, ctx) => {
    const key = sessionKey(ctx);
    const st = getState(key);
    const cf = getConfig(key);

    if (!event.messages || event.messages.length === 0) return;

    // Estimate the total context tokens
    const totalTokens = event.messages.reduce((sum, m) => {
      try { return sum + estimateTokens(JSON.stringify(m)); } catch { return sum; }
    }, 0);

    if (totalTokens < cf.tokenBudget * cf.thresholdRatio) return;

    const { messages, citations } = transformContext(cf, st, event.messages);
    if (citations.length > 0) {
      debugLog(cf, `ARC: ${citations.length} citazioni generate per ${totalTokens} tokens`);
      if (ctx?.hasUI) {
        ctx.ui.notify(`ARC: ${citations.length} tool output archiviati come citazioni`, 'info');
      }
    }

    return { messages };
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    const key = sessionKey(ctx);
    debugLog(getConfig(key), `SESSION SHUTDOWN — entries: ${getState(key).totalEntries}, archived tokens: ${getState(key).totalArchivedTokens}`);
    dropState(key);
  });
}
