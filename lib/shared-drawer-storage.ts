import { kvGet, kvSet, registerDynamicPrefix, registerKvMigration } from "./kv-db";
import { readCustomAppCollection } from "./custom-app-storage";

const SHARED_DRAWER_ITEMS_KEY = "ai_phone_shared_drawer_items_v1";
const SHARED_DRAWER_ACTIVITY_PREFIX = "ai_phone_shared_drawer_activity_v1:";
const SHARED_DRAWER_PROJECTION_PREFIX = "ai_phone_shared_drawer_projection_v1:";
const MAX_ITEMS = 400;
const MAX_DAILY_ACTIVITIES = 24;
const MAX_PROJECTIONS_PER_CHARACTER = 180;

registerKvMigration(SHARED_DRAWER_ITEMS_KEY);
registerDynamicPrefix(SHARED_DRAWER_ACTIVITY_PREFIX);
registerDynamicPrefix(SHARED_DRAWER_PROJECTION_PREFIX);

export const SHARED_DRAWER_UPDATED_EVENT = "ai-phone-shared-drawer-updated";

export type SharedDrawerItemType =
  | "cinema_ticket"
  | "cinema_missed"
  | "note"
  | "game_art"
  /** @deprecated 音乐不再与共同抽屉联动，仅保留旧数据兼容。 */
  | "music"
  | "gift"
  | "plant"
  | "stamp"
  | "found_object";

export type SharedDrawerSourceApp =
  | "dwelling"
  | "calendar"
  | "diary"
  | "shopping"
  /** @deprecated 音乐不再与共同抽屉联动，仅保留旧数据兼容。 */
  | "music"
  | "game"
  | "cinema"
  | "shared_drawer";

export type SharedDrawerItem = {
  id: string;
  type: SharedDrawerItemType;
  sourceApp: SharedDrawerSourceApp;
  title: string;
  subtitle?: string;
  note?: string;
  createdAt: string;
  characterIds: string[];
  characterNames?: string[];
  pinned?: boolean;
  mediaAssetId?: string;
  sourceEventId?: string;
  metadata?: Record<string, unknown>;
};

export type CompanionActivityImportance = "routine" | "meaningful" | "milestone";

export type CompanionActivity = {
  id: string;
  sourceApp: SharedDrawerSourceApp;
  kind: string;
  label: string;
  detail?: string;
  characterId: string;
  characterName?: string;
  createdAt: string;
  importance: CompanionActivityImportance;
  sourceEventId?: string;
};

export type SharedDrawerProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
  importance: CompanionActivityImportance;
  sourceEventId?: string;
};

type RecordActivityInput = Omit<CompanionActivity, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

type AddDrawerItemInput = Omit<SharedDrawerItem, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function cleanMultiline(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, maxLength);
}
function createId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${suffix}`;
}

function normalizeIso(value?: string | number): string {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function formatProjectionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function localDateKey(value: string | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safe.getFullYear();
  const month = String(safe.getMonth() + 1).padStart(2, "0");
  const day = String(safe.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emitUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SHARED_DRAWER_UPDATED_EVENT));
}

function parseList<T>(raw: string | null, guard: (value: unknown) => value is T): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

function isDrawerItem(value: unknown): value is SharedDrawerItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SharedDrawerItem>;
  return typeof item.id === "string"
    && typeof item.type === "string"
    && typeof item.sourceApp === "string"
    && typeof item.title === "string"
    && typeof item.createdAt === "string"
    && Array.isArray(item.characterIds);
}

function isActivity(value: unknown): value is CompanionActivity {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CompanionActivity>;
  return typeof item.id === "string"
    && typeof item.sourceApp === "string"
    && typeof item.kind === "string"
    && typeof item.label === "string"
    && typeof item.characterId === "string"
    && typeof item.createdAt === "string";
}

function isProjection(value: unknown): value is SharedDrawerProjectionEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SharedDrawerProjectionEntry>;
  return typeof item.id === "string"
    && typeof item.timestamp === "string"
    && typeof item.content === "string";
}

function activityKey(characterId: string, dateKey: string): string {
  return `${SHARED_DRAWER_ACTIVITY_PREFIX}${characterId}:${dateKey}`;
}

function projectionKey(characterId: string): string {
  return `${SHARED_DRAWER_PROJECTION_PREFIX}${characterId}`;
}

function saveProjection(characterId: string, entry: SharedDrawerProjectionEntry): void {
  const current = loadSharedDrawerProjectionEntries(characterId);
  const next = [...current.filter((item) => item.id !== entry.id), entry]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_PROJECTIONS_PER_CHARACTER);
  kvSet(projectionKey(characterId), JSON.stringify(next));
}

function buildDailySummary(characterId: string, characterName: string, dateKey: string): SharedDrawerProjectionEntry | null {
  const activities = loadCompanionActivities(characterId, dateKey);
  if (activities.length === 0) return null;
  const labels = activities
    .map((item) => item.detail ? `${item.label}（${item.detail}）` : item.label)
    .filter((label, index, list) => list.indexOf(label) === index)
    .slice(0, 8);
  const who = characterName || activities.find((item) => item.characterName)?.characterName || "角色";
  const latest = activities[activities.length - 1]?.createdAt ?? new Date().toISOString();
  return {
    id: `shared_day_${characterId}_${dateKey}`,
    timestamp: latest,
    importance: "routine",
    content: `[共同生活 ${dateKey}] 用户与${who}今天有这些日常片段：${labels.join("；")}。这些是轻量生活记录，不代表新的关系阶段，也不应逐条重复提起。`,
  };
}

export function loadSharedDrawerItems(): SharedDrawerItem[] {
  if (typeof window === "undefined") return [];
  return parseList(kvGet(SHARED_DRAWER_ITEMS_KEY), isDrawerItem)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

export function addSharedDrawerItem(input: AddDrawerItemInput): SharedDrawerItem {
  const createdAt = normalizeIso(input.createdAt);
  const item: SharedDrawerItem = {
    id: cleanText(input.id, 180) || createId("drawer"),
    type: input.type,
    sourceApp: input.sourceApp,
    title: cleanText(input.title, 160) || "未命名收藏",
    subtitle: cleanText(input.subtitle, 240) || undefined,
    note: cleanMultiline(input.note, 8000) || undefined,
    createdAt,
    characterIds: [...new Set(input.characterIds.map((id) => cleanText(id, 160)).filter(Boolean))],
    characterNames: input.characterNames?.map((name) => cleanText(name, 80)).filter(Boolean),
    pinned: input.pinned === true,
    mediaAssetId: cleanText(input.mediaAssetId, 240) || undefined,
    sourceEventId: cleanText(input.sourceEventId, 180) || undefined,
    metadata: input.metadata,
  };
  const current = loadSharedDrawerItems();
  const existing = item.sourceEventId
    ? current.find((entry) => entry.sourceApp === item.sourceApp && entry.sourceEventId === item.sourceEventId)
    : current.find((entry) => entry.id === item.id);
  if (existing) return existing;
  const next = [item, ...current]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_ITEMS);
  kvSet(SHARED_DRAWER_ITEMS_KEY, JSON.stringify(next));
  emitUpdated();
  return item;
}

export function removeSharedDrawerItem(itemId: string): void {
  const next = loadSharedDrawerItems().filter((item) => item.id !== itemId);
  kvSet(SHARED_DRAWER_ITEMS_KEY, JSON.stringify(next));
  emitUpdated();
}

export function toggleSharedDrawerItemPinned(itemId: string): SharedDrawerItem | null {
  let updated: SharedDrawerItem | null = null;
  const next = loadSharedDrawerItems().map((item) => {
    if (item.id !== itemId) return item;
    updated = { ...item, pinned: !item.pinned };
    return updated;
  });
  kvSet(SHARED_DRAWER_ITEMS_KEY, JSON.stringify(next));
  emitUpdated();
  return updated;
}

export function loadCompanionActivities(characterId: string, dateKey = localDateKey()): CompanionActivity[] {
  if (typeof window === "undefined" || !characterId) return [];
  return parseList(kvGet(activityKey(characterId, dateKey)), isActivity)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function recordCompanionActivity(input: RecordActivityInput): CompanionActivity | null {
  const characterId = cleanText(input.characterId, 160);
  const label = cleanText(input.label, 180);
  if (!characterId || !label || typeof window === "undefined") return null;
  const createdAt = normalizeIso(input.createdAt);
  const dateKey = localDateKey(createdAt);
  const sourceEventId = cleanText(input.sourceEventId, 180) || undefined;
  const activity: CompanionActivity = {
    id: cleanText(input.id, 180) || createId("activity"),
    sourceApp: input.sourceApp,
    kind: cleanText(input.kind, 100) || "interaction",
    label,
    detail: cleanText(input.detail, 360) || undefined,
    characterId,
    characterName: cleanText(input.characterName, 80) || undefined,
    createdAt,
    importance: input.importance,
    sourceEventId,
  };
  const current = loadCompanionActivities(characterId, dateKey);
  const next = [...current.filter((item) => sourceEventId ? item.sourceEventId !== sourceEventId : item.id !== activity.id), activity]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_DAILY_ACTIVITIES);
  kvSet(activityKey(characterId, dateKey), JSON.stringify(next));

  if (activity.importance === "routine") {
    const daily = buildDailySummary(characterId, activity.characterName || "", dateKey);
    if (daily) saveProjection(characterId, daily);
  } else {
    const time = formatProjectionTimestamp(createdAt);
    saveProjection(characterId, {
      id: sourceEventId ? `shared_event_${characterId}_${sourceEventId}` : `shared_event_${activity.id}`,
      timestamp: createdAt,
      importance: activity.importance,
      sourceEventId,
      content: `[共同生活 ${time}] ${activity.characterName || "角色"}与用户留下了一件${activity.importance === "milestone" ? "重要" : "值得记住"}的事：${activity.label}${activity.detail ? `。${activity.detail}` : ""}`,
    });
  }
  emitUpdated();
  return activity;
}

export function loadSharedDrawerProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): SharedDrawerProjectionEntry[] {
  if (typeof window === "undefined" || !characterId) return [];
  const entries = parseList(kvGet(projectionKey(characterId)), isProjection)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!options?.afterTimestamp) return entries;
  return entries.filter((entry) => entry.timestamp > options.afterTimestamp!);
}

export function formatSharedDrawerDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export type LanternCinemaCollectible = {
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  createdAt: string;
  characterIds: string[];
  characterNames: string[];
  metadata: Record<string, unknown>;
};

/**
 * Finished screenings are offered as manual keepsakes. Opening the drawer must
 * never write a ticket; missed, expired and aborted screenings stay excluded.
 */
export function loadLanternCinemaCollectibles(): LanternCinemaCollectible[] {
  if (typeof window === "undefined") return [];
  const rows = readCustomAppCollection("k-lantern-cinema", "screenings");
  const archivedIds = new Set(
    loadSharedDrawerItems()
      .filter((entry) => entry.sourceApp === "cinema" && entry.sourceEventId)
      .map((entry) => entry.sourceEventId as string),
  );
  const collectibles: LanternCinemaCollectible[] = [];
  for (const row of rows) {
    if (row.status !== "finished" || !row.id || !row.film || typeof row.film !== "object") continue;
    const screeningId = cleanText(row.id, 180);
    if (!screeningId || archivedIds.has(screeningId)) continue;
    const film = row.film as Record<string, unknown>;
    const companions = Array.isArray(row.companions)
      ? row.companions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
    const title = cleanText(film.title, 160) || "灯塔电影夜";
    const en = cleanText(film.en, 160);
    const seats = Array.isArray(row.seats) ? row.seats.map((seat) => cleanText(seat, 20)).filter(Boolean) : [];
    const startAt = typeof row.startAt === "number" || typeof row.startAt === "string"
      ? normalizeIso(row.startAt)
      : new Date().toISOString();
    const reviews = row.reviews && typeof row.reviews === "object"
      ? Object.values(row.reviews as Record<string, unknown>)
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
        .map((value) => cleanText(value.text, 500))
        .filter(Boolean)
      : [];
    collectibles.push({
      id: screeningId,
      title,
      subtitle: [en, seats.length ? `座位 ${seats.join(" / ")}` : ""].filter(Boolean).join(" · "),
      note: companions.length
        ? [`与 ${companions.map((item) => cleanText(item.name, 80)).filter(Boolean).join("、")} 完成了这场观影。`, ...reviews].join("\n\n")
        : "一个人的电影夜，也被好好收了起来。",
      createdAt: startAt,
      characterIds: companions.map((item) => cleanText(item.id, 160)).filter(Boolean),
      characterNames: companions.map((item) => cleanText(item.name, 80)).filter(Boolean),
      metadata: {
        filmId: cleanText(film.id, 180),
        ticketNumber: cleanText(row.ticketNumber, 120),
        seats,
        startedAt: startAt,
        endedAt: normalizeIso(row.endAt as string | number | undefined),
      },
    });
  }
  return collectibles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function collectLanternCinemaTicket(ticket: LanternCinemaCollectible): SharedDrawerItem {
  const item = addSharedDrawerItem({
    type: "cinema_ticket",
    sourceApp: "cinema",
    title: ticket.title,
    subtitle: ticket.subtitle,
    note: ticket.note,
    createdAt: ticket.createdAt,
    characterIds: ticket.characterIds,
    characterNames: ticket.characterNames,
    sourceEventId: ticket.id,
    metadata: ticket.metadata,
  });
  ticket.characterIds.forEach((characterId, index) => {
    recordCompanionActivity({
      sourceApp: "cinema",
      kind: "cinema_finished",
      label: `一起看完了《${ticket.title}》`,
      detail: "散场后把票根收进了共同抽屉",
      characterId,
      characterName: ticket.characterNames[index],
      createdAt: ticket.createdAt,
      importance: "meaningful",
      sourceEventId: `cinema-finished:${ticket.id}`,
    });
  });
  return item;
}
