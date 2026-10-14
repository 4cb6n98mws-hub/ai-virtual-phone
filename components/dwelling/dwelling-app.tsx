"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Armchair, ChevronLeft, Compass, DoorOpen, Lightbulb, PackagePlus, RefreshCw, Trash2, Wand2, X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import type { DwellingLayout, DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import {
    loadDwellingLayout,
    saveDwellingLayout,
    clearDwellingData,
    saveItemHtml,
    loadAllItemHtmlForChar,
    loadDwellingImageEnabled,
    saveDwellingImageEnabled,
    collectRoomImageRefs,
} from "@/lib/dwelling-storage";
import { generateDwellingLayout, generateItemHtml, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { pinyin } from "pinyin-pro";
import { getDwellingImageAvailability, generateDwellingRoomImage, cancelDwellingRoomImage } from "@/lib/dwelling-image";
import { deleteMediaRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { RoomView, type DwellingRoomImageStatus } from "./room-view";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { kvGet, kvSet } from "@/lib/kv-db";
import { addSharedDrawerItem, recordCompanionActivity } from "@/lib/shared-drawer-storage";

type DwellingAppProps = {
    onClose: () => void;
    visible?: boolean;
    onIdle?: () => void;
};

type CharState = {
    layout: DwellingLayout | null;
    isGenerating: boolean;
    error: string | null;
    loaded: boolean;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    /** roomId → 生图失败原因（存在时不再自动重试，需手动重试） */
    imageErrors: Record<string, string>;
    /** 正在生图的 roomId 集合 */
    generatingImageRooms: Set<string>;
    /** 一键探索：是否进行中 / 总数 / 已处理 / 当前物品名 / 用户已点停止 */
    batchExploring: boolean;
    batchTotal: number;
    batchDone: number;
    batchCurrent: string | null;
    batchCancelled: boolean;
};

type ItemDetail = {
    roomId: string;
    roomName: string;
    furnitureId: string;
    furnitureLabel: string;
    furnitureIcon: string;
    itemId: string;
    itemName: string;
    itemPreview: string;
    html: string;
};

const charStates = new Map<string, CharState>();

function getCharState(charId: string): CharState {
    let s = charStates.get(charId);
    if (!s) { s = { layout: null, isGenerating: false, error: null, loaded: false, itemHtmlCache: {}, loadingItemKeys: new Set(), lastItemError: null, imageErrors: {}, generatingImageRooms: new Set(), batchExploring: false, batchTotal: 0, batchDone: 0, batchCurrent: null, batchCancelled: false }; charStates.set(charId, s); }
    return s;
}

function itemKey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

function localDayKey(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function stableHash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function resolveHomeStatus(characterId: string, now: Date): { label: string; detail: string; atHome: boolean } {
    const hour = now.getHours();
    const weekday = now.getDay();
    const roll = stableHash(`${characterId}:${localDayKey(now)}`) % 10;
    if (hour < 6) return { label: "屋里很安静", detail: "灯已经熄了，应该还在睡。", atHome: true };
    if (hour < 8) return { label: "已经起床", detail: roll < 4 ? "厨房那边像是刚煮过咖啡。" : "窗帘拉开了一半。", atHome: true };
    if (hour < 12) {
        const atHome = weekday === 0 || weekday === 6 || roll < 3;
        return atHome
            ? { label: "人在家里", detail: roll % 2 ? "车库里偶尔传来工具声。" : "屋里有人走动。", atHome: true }
            : { label: "暂时出门", detail: "玄关很安静，晚些时候再来看看。", atHome: false };
    }
    if (hour < 17) {
        const atHome = weekday === 0 || weekday === 6 || roll < 4;
        return atHome
            ? { label: "午后在家", detail: roll % 2 ? "客厅留着一点音乐声。" : "像是在处理修到一半的东西。", atHome: true }
            : { label: "外出中", detail: "门口没有动静，应该还没回来。", atHome: false };
    }
    if (hour < 22) return { label: "已经回家", detail: roll < 3 ? "厨房亮着灯。" : roll < 7 ? "客厅里很安静。" : "像是刚结束训练。", atHome: true };
    return { label: "准备休息", detail: roll % 2 ? "只留了一盏小灯。" : "屋子慢慢安静下来。", atHome: true };
}

function porchLightKey(characterId: string): string {
    return `ai_phone_dwelling_porch_light_v1:${characterId}`;
}

/** mediaRef → object URL（会话级缓存，图不多，不主动 revoke） */
const roomImageUrls = new Map<string, string>();

/** 角色名 → 大写拼音（chip 下行幽灵字） */
const charEnCache = new Map<string, string>();
function charChipEn(name: string): string {
    let en = charEnCache.get(name);
    if (en === undefined) {
        try { en = pinyin(name, { toneType: "none" }).toUpperCase(); } catch { en = ""; }
        charEnCache.set(name, en);
    }
    return en;
}

export function DwellingApp({ onClose, visible, onIdle }: DwellingAppProps) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    const [activeRoomIdx, setActiveRoomIdx] = useState(0);
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(n => n + 1);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    /** 一键探索确认：count 为本次会探索（= 调用模型）的物品数，0 表示都探索过了 */
    const [exploreAllConfirm, setExploreAllConfirm] = useState<{ charId: string; count: number } | null>(null);
    const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
    const [imageEnabled, setImageEnabled] = useState(true);
    const [imageConfigured, setImageConfigured] = useState(false);
    const [nowTick, setNowTick] = useState(() => new Date());
    const [porchLightOn, setPorchLightOn] = useState(false);
    const [lifeNotice, setLifeNotice] = useState<string | null>(null);
    const activeCharIdRef = useRef<string | null>(null);
    const activeRoomIdxRef = useRef(0);
    // 一键探索可能跑好几分钟，结束时要读最新的可见状态和回调，不能用发起时的闭包
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const onIdleRef = useRef(onIdle);
    onIdleRef.current = onIdle;

    useEffect(() => {
        setImageEnabled(loadDwellingImageEnabled());
        setImageConfigured(getDwellingImageAvailability().configured);
        const timer = window.setInterval(() => setNowTick(new Date()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!activeCharId) {
            setPorchLightOn(false);
            return;
        }
        setPorchLightOn(kvGet(porchLightKey(activeCharId)) === "1");
    }, [activeCharId]);

    useEffect(() => {
        // 用户可能中途去设置里配置了生图，回到栖所时重新判定
        if (visible) setImageConfigured(getDwellingImageAvailability().configured);
    }, [visible]);

    useEffect(() => {
        activeCharIdRef.current = activeCharId;
    }, [activeCharId]);

    useEffect(() => {
        activeRoomIdxRef.current = activeRoomIdx;
    }, [activeRoomIdx]);

    useEffect(() => {
        if (visible) {
            if (activeCharId) getCharState(activeCharId).error = null;
            rerender();
        }
    }, [visible, activeCharId]);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        if (chars.length === 1) setActiveCharId(chars[0].id);
        // Pre-load all characters' cached layouts + item HTML so ✓ shows immediately
        (async () => {
            for (const c of chars) {
                const cs = getCharState(c.id);
                if (cs.loaded) continue;
                const cached = await loadDwellingLayout(c.id);
                cs.loaded = true;
                if (cached) {
                    cs.layout = cached.layout;
                    cs.itemHtmlCache = loadAllItemHtmlForChar(c.id);
                }
            }
            rerender();
        })();
    }, []);

    useEffect(() => {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        cs.error = null;
        if (cs.loaded) { rerender(); return; }
        let cancelled = false;
        (async () => {
            const cached = await loadDwellingLayout(activeCharId);
            if (cancelled) return;
            cs.loaded = true;
            if (cached) {
                cs.layout = cached.layout;
                cs.itemHtmlCache = loadAllItemHtmlForChar(activeCharId);
            }
            rerender();
        })();
        return () => { cancelled = true; };
    }, [activeCharId]);

    const doGenerate = useCallback(async (charId: string, mode: DwellingRefreshMode = "full") => {
        const cs = getCharState(charId);
        cs.isGenerating = true;
        cs.error = null;
        if (mode === "full") {
            cs.layout = null;
            cs.itemHtmlCache = {};
        }
        rerender();

        const { layout: newLayout, error: genError } = await generateDwellingLayout(charId, mode);
        cs.isGenerating = false;
        if (!newLayout) {
            cs.error = genError || "生成失败";
            rerender();
            if (!visible && onIdle) onIdle();
            return;
        }
        cs.layout = newLayout;
        cs.loaded = true;
        // Items mode: clear HTML cache for items with new IDs (changed items)
        if (mode === "items") {
            const newKeys = new Set<string>();
            for (const room of newLayout.rooms) {
                for (const f of room.furniture) {
                    for (const item of f.items) {
                        newKeys.add(itemKey(room.id, item.id));
                    }
                }
            }
            // Remove HTML cache entries that no longer exist (removed/changed items)
            for (const key of Object.keys(cs.itemHtmlCache)) {
                if (!newKeys.has(key)) delete cs.itemHtmlCache[key];
            }
        } else {
            cs.itemHtmlCache = {};
        }
        await saveDwellingLayout(charId, newLayout);
        rerender();
        if (!visible && onIdle) onIdle();
    }, [visible, onIdle]);

    async function handleRefresh(mode: DwellingRefreshMode) {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        setItemDetail(null);
        if (mode === "full") {
            for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
            cs.imageErrors = {};
            await clearDwellingData(activeCharId);
        }
        await doGenerate(activeCharId, mode);
    }

    async function handleDelete() {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
        await clearDwellingData(activeCharId);
        cs.layout = null;
        cs.itemHtmlCache = {};
        cs.error = null;
        cs.imageErrors = {};
        setActiveRoomIdx(0);
        setItemDetail(null);
        rerender();
    }

    // ── 房间生图 ──
    const handleGenerateRoomImage = useCallback(async (charId: string, roomId: string) => {
        const cs = getCharState(charId);
        const layout = cs.layout;
        if (!layout) return;
        const room = layout.rooms.find(r => r.id === roomId);
        if (!room) return;
        if (cs.generatingImageRooms.has(roomId)) return;

        cs.generatingImageRooms.add(roomId);
        delete cs.imageErrors[roomId];
        rerender();

        const { assetId, error } = await generateDwellingRoomImage(charId, room);
        cs.generatingImageRooms.delete(roomId);

        // 生成期间布局被重建/删除：丢弃这张图
        if (cs.layout !== layout) {
            if (assetId) void deleteMediaRef(assetId);
            rerender();
            return;
        }

        if (assetId) {
            const old = room.imageAssetId;
            room.imageAssetId = assetId;
            if (old && old !== assetId) void deleteMediaRef(old);
            const url = await loadMediaObjectUrl(assetId);
            if (url) roomImageUrls.set(assetId, url);
            await saveDwellingLayout(charId, layout);
        } else {
            cs.imageErrors[roomId] = error || "生成失败";
        }
        rerender();
    }, []);

    // 进入房间：已有图则解析 URL；没有图且生图可用则自动生成
    const csForImage = activeCharId ? getCharState(activeCharId) : null;
    const roomForImage = csForImage?.layout?.rooms[activeRoomIdx] ?? null;
    useEffect(() => {
        if (visible === false) return;
        if (!activeCharId || !csForImage?.layout || !roomForImage) return;
        const cs = csForImage;
        const room = roomForImage;

        if (room.imageAssetId) {
            const ref = room.imageAssetId;
            if (roomImageUrls.has(ref)) return;
            let cancelled = false;
            (async () => {
                const url = await loadMediaObjectUrl(ref);
                if (cancelled) return;
                if (url) {
                    roomImageUrls.set(ref, url);
                } else if (cs.layout && cs.layout.rooms.includes(room)) {
                    // 媒体已丢失：清掉引用，回氛围底并允许重新生成
                    room.imageAssetId = undefined;
                    void saveDwellingLayout(activeCharId, cs.layout);
                }
                rerender();
            })();
            return () => { cancelled = true; };
        }

        if (imageEnabled && imageConfigured && !cs.generatingImageRooms.has(room.id) && !cs.imageErrors[room.id]) {
            void handleGenerateRoomImage(activeCharId, room.id);
        }
    }, [activeCharId, activeRoomIdx, imageEnabled, imageConfigured, visible, csForImage, roomForImage, handleGenerateRoomImage]);

    function openItemDetail(room: DwellingRoom, furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) {
        setItemDetail({
            roomId: room.id,
            roomName: room.name,
            furnitureId: furniture.id,
            furnitureLabel: furniture.label,
            furnitureIcon: furniture.icon,
            itemId: item.id,
            itemName: item.name,
            itemPreview: item.preview,
            html,
        });
    }

    // ── Explore single item (called from RoomView) ──
    async function handleExploreItem(charId: string, roomId: string, furniture: DwellingFurniture, item: DwellingFurnitureItem) {
        const cs = getCharState(charId);
        const room = cs.layout?.rooms.find(r => r.id === roomId);
        if (!room) return;

        const key = itemKey(roomId, item.id);
        if (cs.loadingItemKeys.has(key)) return; // already loading
        cs.loadingItemKeys.add(key);
        cs.lastItemError = null;
        rerender();

        const { html, error } = await generateItemHtml(charId, room.name, furniture.label, item.name, item.preview);

        cs.loadingItemKeys.delete(key);
        if (html) {
            cs.itemHtmlCache[key] = html;
            void saveItemHtml(charId, roomId, item.id, html);
            const currentRoom = activeCharIdRef.current === charId ? cs.layout?.rooms[activeRoomIdxRef.current] : null;
            if (currentRoom?.id === roomId) openItemDetail(room, furniture, item, html);
        }
        cs.lastItemError = error || null;
        rerender();
    }

    // ── 一键探索全部物品 ──
    // 只处理还没探索过、也不在单独探索中的物品；和单件探索共用 loadingItemKeys，互相不会重复生成。
    function collectUnexploredItems(cs: CharState) {
        const entries: { room: DwellingRoom; furniture: DwellingFurniture; item: DwellingFurnitureItem }[] = [];
        for (const room of cs.layout?.rooms ?? []) {
            for (const furniture of room.furniture) {
                for (const item of furniture.items) {
                    const key = itemKey(room.id, item.id);
                    if (cs.itemHtmlCache[key] || cs.loadingItemKeys.has(key)) continue;
                    entries.push({ room, furniture, item });
                }
            }
        }
        return entries;
    }

    function requestExploreAll(charId: string) {
        const cs = getCharState(charId);
        if (cs.isGenerating || cs.batchExploring || !cs.layout) return;
        setExploreAllConfirm({ charId, count: collectUnexploredItems(cs).length });
    }

    async function handleExploreAll(charId: string) {
        const cs = getCharState(charId);
        const layout = cs.layout;
        if (cs.isGenerating || cs.batchExploring || !layout) return;
        const entries = collectUnexploredItems(cs);
        if (entries.length === 0) return;

        cs.batchExploring = true;
        cs.batchTotal = entries.length;
        cs.batchDone = 0;
        cs.batchCurrent = null;
        cs.batchCancelled = false;
        cs.lastItemError = null;
        rerender();

        try {
            for (const { room, furniture, item } of entries) {
                if (cs.batchCancelled || cs.layout !== layout) break;
                const key = itemKey(room.id, item.id);
                // 批量途中用户自己点开过的物品：已有结果或正在生成，直接跳过
                if (cs.itemHtmlCache[key] || cs.loadingItemKeys.has(key)) {
                    cs.batchDone += 1;
                    rerender();
                    continue;
                }
                cs.batchCurrent = item.name;
                cs.loadingItemKeys.add(key);
                rerender();
                const { html, error } = await generateItemHtml(charId, room.name, furniture.label, item.name, item.preview);
                cs.loadingItemKeys.delete(key);
                if (html && cs.layout === layout) {
                    cs.itemHtmlCache[key] = html;
                    void saveItemHtml(charId, room.id, item.id, html);
                }
                cs.batchDone += 1;
                if (!html) {
                    // 失败多半是接口或额度问题，继续只会接着失败、白白消耗，直接停下
                    cs.lastItemError = error || "探索失败";
                    break;
                }
                rerender();
            }
        } finally {
            cs.batchExploring = false;
            cs.batchCurrent = null;
            cs.batchCancelled = false;
            rerender();
            const busy = [...charStates.values()].some(state => state.isGenerating || state.batchExploring || state.loadingItemKeys.size > 0);
            if (!visibleRef.current && !busy) onIdleRef.current?.();
        }
    }

    function handleStopExploreAll(charId: string) {
        getCharState(charId).batchCancelled = true;
        rerender();
    }

    const cs = activeCharId ? getCharState(activeCharId) : null;
    const activeRoom = cs?.layout?.rooms[activeRoomIdx] ?? null;
    const activeCharacter = characters.find((character) => character.id === activeCharId) ?? null;
    const homeStatus = activeCharId ? resolveHomeStatus(activeCharId, nowTick) : null;

    function recordDwellingMoment(kind: string, label: string, detail?: string) {
        if (!activeCharacter) return;
        recordCompanionActivity({
            sourceApp: "dwelling",
            kind,
            label,
            detail,
            characterId: activeCharacter.id,
            characterName: activeCharacter.name,
            importance: "routine",
        });
    }

    function handleKnock() {
        if (!activeCharacter || !homeStatus) return;
        recordDwellingMoment("knock", "在栖所敲了敲门", homeStatus.atHome ? "门内有人，敲门声被听见了" : "角色暂时不在家");
        setLifeNotice(homeStatus.atHome ? "敲门声留在玄关里了。" : "屋里没人应门，敲门声仍被记在今天。" );
    }

    function handleSitTogether() {
        if (!activeCharacter) return;
        recordDwellingMoment("sofa", "在栖所的沙发上待了一会儿", homeStatus?.atHome ? "两个人共享了一段安静时间" : "用户在安静的屋里等了一会儿");
        setLifeNotice(homeStatus?.atHome ? "这一小段安静，被算进今天了。" : "沙发空着，屋里替你留了一会儿。" );
    }

    function handlePorchLight() {
        if (!activeCharacter) return;
        const next = !porchLightOn;
        setPorchLightOn(next);
        kvSet(porchLightKey(activeCharacter.id), next ? "1" : "0");
        recordDwellingMoment("porch_light", next ? "替栖所留了一盏玄关灯" : "关掉了栖所的玄关灯");
        setLifeNotice(next ? "玄关灯亮着，等人回家。" : "玄关灯关好了。" );
    }

    function handleKeepItem() {
        if (!activeCharacter || !itemDetail) return;
        const sourceEventId = `${activeCharacter.id}:${itemDetail.roomId}:${itemDetail.itemId}`;
        const looksLikePlant = /(?:植物|盆栽|花盆|绿植|枝叶|花束|花瓶|plant|flower|fern|succulent)/i
            .test(`${itemDetail.itemName} ${itemDetail.itemPreview}`);
        addSharedDrawerItem({
            type: looksLikePlant ? "plant" : "found_object",
            sourceApp: "dwelling",
            title: itemDetail.itemName,
            subtitle: `${activeCharacter.name}的${itemDetail.roomName} · ${itemDetail.furnitureLabel}`,
            note: itemDetail.itemPreview,
            characterIds: [activeCharacter.id],
            characterNames: [activeCharacter.name],
            sourceEventId,
            metadata: { roomId: itemDetail.roomId, furnitureId: itemDetail.furnitureId, itemId: itemDetail.itemId },
        });
        recordCompanionActivity({
            sourceApp: "dwelling",
            kind: "kept_object",
            label: `把「${itemDetail.itemName}」收进了共同抽屉`,
            detail: `${itemDetail.roomName} · ${itemDetail.furnitureLabel}`,
            characterId: activeCharacter.id,
            characterName: activeCharacter.name,
            importance: "meaningful",
            sourceEventId: `drawer:${sourceEventId}`,
        });
        setLifeNotice("已经收进共同抽屉。" );
    }

    return (
        <div className="dwelling-app" data-haspicker={characters.length > 1 ? "true" : undefined}>
            <div className="dwelling-header">
                <button className="dw-back" onClick={onClose}><ChevronLeft size={18} /></button>
                <h1>栖 所<span className="dw-title-en">DWELLING</span></h1>
            </div>

            {characters.length > 1 && (
                <div className="dwelling-char-picker">
                    {characters.map(c => {
                        const s = getCharState(c.id);
                        return (
                            <button key={c.id} className="dwelling-char-chip"
                                data-active={activeCharId === c.id ? "true" : undefined}
                                onClick={() => { setActiveCharId(c.id); setActiveRoomIdx(0); setItemDetail(null); }}>
                                <span className="dw-chip-zh">{c.name}{s.isGenerating ? " …" : s.layout ? " ✓" : ""}</span>
                                {charChipEn(c.name) && <span className="dw-chip-en">{charChipEn(c.name)}</span>}
                            </button>
                        );
                    })}
                </div>
            )}

            {!activeCharId && characters.length > 1 && (
                <div className="dwelling-empty"><span>选择一位角色，探索 ta 的栖所</span></div>
            )}
            {characters.length === 0 && (
                <div className="dwelling-empty"><span>还没有角色，去创建一个吧</span></div>
            )}
            {cs?.isGenerating && !cs.layout && (
                <div className="dwelling-loading"><div className="dwelling-spinner" /><span className="dwelling-loading-text">正在窥探房间…</span></div>
            )}
            {cs?.isGenerating && cs.layout && (
                <div className="dwelling-loading-bar"><span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><span>刷新中…</span></div>
            )}
            {cs && (cs.error || cs.lastItemError) && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">{cs.error ? "生成失败" : "探索失败"}</div>
                        <div className="dw-confirm-msg dw-error-msg">{cs.error || cs.lastItemError}</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }}>知道了</button>
                        </div>
                    </div>
                </div>
            )}
            {activeCharId && cs?.loaded && !cs.layout && !cs.isGenerating && (
                <div className="dwelling-empty">
                    <span>还未生成 ta 的房间</span>
                    <button className="dwelling-generate-btn" onClick={() => doGenerate(activeCharId)}>
                        <Wand2 size={16} />生成房间
                    </button>
                </div>
            )}

            {cs?.layout && (
                <div className="dwelling-room-tabs">
                    {cs.layout.rooms.map((room, idx) => (
                        <button key={room.id} className="dwelling-room-tab"
                            data-active={activeRoomIdx === idx ? "true" : undefined}
                            onClick={() => { setActiveRoomIdx(idx); setItemDetail(null); }}>
                            {room.name}
                            {room.en && <span className="dw-tab-en">{room.en}</span>}
                        </button>
                    ))}
                    <div className="dw-tabs-actions">
                        <button className="dw-tab-action" onClick={() => requestExploreAll(activeCharId!)} disabled={cs.isGenerating || cs.batchExploring} title="一键探索全部物品" aria-label="一键探索全部物品">
                            <Compass size={13} />
                        </button>
                        <button className="dw-tab-action" onClick={() => setShowRefreshConfirm(true)} disabled={cs.isGenerating || cs.batchExploring} title="重新生成">
                            <RefreshCw size={13} />
                        </button>
                        <button className="dw-tab-action dw-tab-action-danger" onClick={() => setShowDeleteConfirm(true)} disabled={cs.isGenerating || cs.batchExploring} title="删除布局">
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>
            )}

            {activeCharacter && cs?.layout && homeStatus && (
                <section className="dwelling-life-strip" aria-label="栖所生活状态">
                    <div className="dwelling-life-copy">
                        <span>{activeCharacter.name} · {homeStatus.label}</span>
                        <p>{homeStatus.detail}</p>
                    </div>
                    <div className="dwelling-life-actions">
                        <button type="button" onClick={handleKnock} title="敲敲门" aria-label="敲敲门"><DoorOpen size={14} /></button>
                        <button type="button" onClick={handleSitTogether} title="在沙发坐会儿" aria-label="在沙发坐会儿"><Armchair size={14} /></button>
                        <button type="button" data-active={porchLightOn ? "true" : undefined} onClick={handlePorchLight} title="玄关灯" aria-label="切换玄关灯"><Lightbulb size={14} /></button>
                    </div>
                    {lifeNotice ? <button type="button" className="dwelling-life-notice" onClick={() => setLifeNotice(null)}>{lifeNotice}</button> : null}
                </section>
            )}

            {cs?.batchExploring && (
                <div className="dw-batch-bar" role="status" aria-live="polite">
                    <span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    <span className="dw-batch-text">
                        {cs.batchCancelled ? "正在停止…" : `正在探索 ${cs.batchCurrent ?? "…"}`} · {cs.batchDone}/{cs.batchTotal}
                    </span>
                    <button className="dw-batch-cancel" onClick={() => handleStopExploreAll(activeCharId!)} disabled={cs.batchCancelled}>停止</button>
                </div>
            )}

            {activeRoom && cs && (() => {
                const assetUrl = activeRoom.imageAssetId ? roomImageUrls.get(activeRoom.imageAssetId) ?? null : null;
                let imageStatus: DwellingRoomImageStatus = "ambient";
                if (cs.generatingImageRooms.has(activeRoom.id)) imageStatus = "generating";
                else if (imageEnabled && assetUrl) imageStatus = "ready";
                else if (imageEnabled && imageConfigured && cs.imageErrors[activeRoom.id]) imageStatus = "failed";
                return (
                    <RoomView
                        room={activeRoom}
                        itemHtmlCache={cs.itemHtmlCache}
                        loadingItemKeys={cs.loadingItemKeys}
                        lastItemError={cs.lastItemError}
                        onExploreItem={(furniture, item) => handleExploreItem(activeCharId!, activeRoom.id, furniture, item)}
                        onOpenItem={(furniture, item, html) => openItemDetail(activeRoom, furniture, item, html)}
                        onMoveMarker={(furnitureId, marker) => {
                            if (!activeCharId || !cs.layout) return;
                            const roomIdx = cs.layout.rooms.indexOf(activeRoom);
                            if (roomIdx < 0) return;
                            // 不可变更新：房间对象换新引用，RoomView 才会立即重算标注布局
                            cs.layout.rooms[roomIdx] = {
                                ...activeRoom,
                                furniture: activeRoom.furniture.map(f => f.id === furnitureId ? { ...f, marker } : f),
                            };
                            void saveDwellingLayout(activeCharId, cs.layout);
                            rerender();
                        }}
                        imageUrl={imageEnabled ? assetUrl : null}
                        imageStatus={imageStatus}
                        imageError={cs.imageErrors[activeRoom.id] ?? null}
                        imageEnabled={imageEnabled}
                        imageConfigured={imageConfigured}
                        onToggleImage={() => {
                            const next = !imageEnabled;
                            setImageEnabled(next);
                            saveDwellingImageEnabled(next);
                            // 重新打开开关视为想再试一次：清掉失败记录，让自动生成重新触发
                            if (next) cs.imageErrors = {};
                        }}
                        onRetryImage={() => { if (activeCharId) void handleGenerateRoomImage(activeCharId, activeRoom.id); }}
                        onCancelImage={() => { if (activeCharId) cancelDwellingRoomImage(activeCharId, activeRoom.id); }}
                    />
                );
            })()}
            {itemDetail && (
                <div className="dwelling-detail-overlay" data-show="true">
                    <div className="dwelling-items-shade" onClick={() => setItemDetail(null)} />
                    <div className="dwelling-detail-card" role="dialog" aria-modal="true" aria-label={itemDetail.itemName}>
                        <div className="dwelling-items-header">
                            <div className="dwelling-detail-heading">
                                <div className="dwelling-detail-name">{itemDetail.itemName}</div>
                                <div className="dwelling-detail-location">{itemDetail.roomName} · {itemDetail.furnitureLabel}</div>
                            </div>
                            <button className="dwelling-items-close" onClick={() => setItemDetail(null)} aria-label="关闭">
                                <X size={13} />
                            </button>
                        </div>
                        <div className="dwelling-detail-preview">{itemDetail.itemPreview}</div>
                        <button type="button" className="dwelling-detail-keep" onClick={handleKeepItem}>
                            <PackagePlus size={14} />收进共同抽屉
                        </button>
                        <div className="dwelling-detail-html">
                            <StoryHtmlRenderer
                                content={itemDetail.html}
                                messageId={`dw-detail-${itemDetail.roomId}-${itemDetail.furnitureId}-${itemDetail.itemId}`}
                                htmlPageMode="contained"
                            />
                        </div>
                    </div>
                </div>
            )}
            {/* Refresh confirm dialog */}
            {showRefreshConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowRefreshConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">刷新房间</div>
                        <div className="dw-confirm-msg">选择刷新方式</div>
                        <div className="dw-confirm-actions-col">
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("items"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>刷新物品</strong>
                                    <small>保留房间和家具，只更新物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("full"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>完全重建</strong>
                                    <small>重新生成所有房间、家具和物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" style={{ marginTop: 4 }} onClick={() => setShowRefreshConfirm(false)}>取消</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 一键探索确认：先说清楚会调用几次模型 */}
            {exploreAllConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setExploreAllConfirm(null)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">一键探索</div>
                        {exploreAllConfirm.count > 0 ? (
                            <>
                                <div className="dw-confirm-msg">
                                    还有 {exploreAllConfirm.count} 件物品没有探索过<br />
                                    全部探索会调用 {exploreAllConfirm.count} 次模型<br />
                                    过程中可以随时停止
                                </div>
                                <div className="dw-confirm-actions">
                                    <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setExploreAllConfirm(null)}>再想想</button>
                                    <button className="dw-confirm-btn" onClick={() => { const { charId } = exploreAllConfirm; setExploreAllConfirm(null); void handleExploreAll(charId); }}>开始探索</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="dw-confirm-msg">这里的物品都已经探索过了</div>
                                <div className="dw-confirm-actions">
                                    <button className="dw-confirm-btn" onClick={() => setExploreAllConfirm(null)}>知道了</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Delete confirm dialog */}
            {showDeleteConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowDeleteConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">要离开这里吗？</div>
                        <div className="dw-confirm-msg">房间里的一切都会消失不见哦<br />包括已经探索过的物品</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowDeleteConfirm(false)}>再想想</button>
                            <button className="dw-confirm-btn dw-confirm-btn-danger" onClick={() => { setShowDeleteConfirm(false); handleDelete(); }}>挥手告别</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
