"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Film,
  Flower2,
  Gamepad2,
  Gift,
  PackageOpen,
  Pin,
  Stamp,
  StickyNote,
  Ticket,
  Trash2,
} from "lucide-react";

import { loadCharacters } from "@/lib/character-storage";
import {
  collectLanternCinemaTicket,
  formatSharedDrawerDate,
  loadLanternCinemaCollectibles,
  loadCompanionActivities,
  loadSharedDrawerItems,
  removeSharedDrawerItem,
  SHARED_DRAWER_UPDATED_EVENT,
  toggleSharedDrawerItemPinned,
  type SharedDrawerItem,
  type SharedDrawerSourceApp,
  type SharedDrawerItemType,
  type CompanionActivity,
  type LanternCinemaCollectible,
} from "@/lib/shared-drawer-storage";

type SharedDrawerAppProps = {
  onClose: () => void;
  onOpenSource?: (source: SharedDrawerSourceApp) => void;
};

type FilterId = "all" | SharedDrawerItemType;

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: "all", label: "全部" },
  { id: "cinema_ticket", label: "票根" },
  { id: "note", label: "便笺" },
  { id: "gift", label: "礼物" },
  { id: "game_art", label: "作品" },
  { id: "plant", label: "植物" },
  { id: "stamp", label: "邮票" },
  { id: "found_object", label: "物件" },
];

const TYPE_LABELS: Record<SharedDrawerItemType, string> = {
  cinema_ticket: "TICKET",
  cinema_missed: "MISSED",
  note: "NOTE",
  game_art: "PLAY",
  music: "MUSIC",
  gift: "GIFT",
  plant: "GARDEN",
  stamp: "STAMP",
  found_object: "FOUND",
};

function ItemIcon({ type }: { type: SharedDrawerItemType }) {
  if (type === "cinema_ticket") return <Ticket size={20} strokeWidth={1.55} />;
  if (type === "cinema_missed") return <Film size={20} strokeWidth={1.55} />;
  if (type === "note") return <StickyNote size={20} strokeWidth={1.55} />;
  if (type === "gift") return <Gift size={20} strokeWidth={1.55} />;
  if (type === "game_art") return <Gamepad2 size={20} strokeWidth={1.55} />;
  if (type === "plant") return <Flower2 size={20} strokeWidth={1.55} />;
  if (type === "stamp") return <Stamp size={20} strokeWidth={1.55} />;
  return <PackageOpen size={20} strokeWidth={1.55} />;
}
function sourceLabel(item: SharedDrawerItem): string {
  const labels: Record<SharedDrawerItem["sourceApp"], string> = {
    dwelling: "栖所",
    calendar: "日历",
    diary: "手记",
    shopping: "购物",
    music: "音乐",
    game: "游戏",
    cinema: "灯塔电影院",
    shared_drawer: "共同抽屉",
  };
  return labels[item.sourceApp];
}

function loadTodayActivities(): CompanionActivity[] {
  return loadCharacters()
    .flatMap((character) => loadCompanionActivities(character.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
}

export function SharedDrawerApp({ onClose, onOpenSource }: SharedDrawerAppProps) {
  const [items, setItems] = useState<SharedDrawerItem[]>(() => loadSharedDrawerItems().filter((item) => item.type !== "music"));
  const [cinemaCollectibles, setCinemaCollectibles] = useState<LanternCinemaCollectible[]>(() => loadLanternCinemaCollectibles());
  const [todayActivities, setTodayActivities] = useState<CompanionActivity[]>(() => loadTodayActivities());
  const [filter, setFilter] = useState<FilterId>("all");
  const [selected, setSelected] = useState<SharedDrawerItem | null>(null);

  useEffect(() => {
    const refresh = () => {
      setItems(loadSharedDrawerItems().filter((item) => item.type !== "music"));
      setCinemaCollectibles(loadLanternCinemaCollectibles());
      setTodayActivities(loadTodayActivities());
    };
    refresh();
    window.addEventListener(SHARED_DRAWER_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(SHARED_DRAWER_UPDATED_EVENT, refresh);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((item) => item.type === filter);
  }, [filter, items]);

  const pinnedCount = items.filter((item) => item.pinned).length;

  function handlePin(item: SharedDrawerItem) {
    const updated = toggleSharedDrawerItemPinned(item.id);
    if (selected?.id === item.id && updated) setSelected(updated);
  }

  function handleDelete(item: SharedDrawerItem) {
    if (!window.confirm(`确定把「${item.title}」移出共同抽屉吗？原应用里的内容不会被删除。`)) return;
    removeSharedDrawerItem(item.id);
    if (selected?.id === item.id) setSelected(null);
  }

  function handleCollectCinema(ticket: LanternCinemaCollectible) {
    collectLanternCinemaTicket(ticket);
  }

  return (
    <section className="shared-drawer-app">
      <header className="shared-drawer-header">
        <button type="button" className="shared-drawer-back companion-app-back" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={20} />
        </button>
        <div className="shared-drawer-title">
          <span>OUR LITTLE ARCHIVE</span>
          <h1>共同抽屉</h1>
        </div>
        <span className="shared-drawer-count">{String(items.length).padStart(2, "0")}</span>
      </header>

      <main className="shared-drawer-main">
        <section className="shared-drawer-intro">
          <div>
            <span className="shared-drawer-kicker">LONG ISLAND · PERSONAL EFFECTS</span>
            <h2>把共同留下的东西，收在这里。</h2>
          </div>
          <p>{pinnedCount > 0 ? `${pinnedCount} 件被别针固定。` : "日常动作只留在当天，值得保存的才会进抽屉。"}</p>
        </section>

        <nav className="shared-drawer-filters" aria-label="收藏分类">
          {FILTERS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              data-active={filter === entry.id ? "true" : undefined}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {todayActivities.length > 0 ? (
          <section className="shared-drawer-today" aria-label="今天的共同日常">
            <div className="shared-drawer-section-heading">
              <span><Clock3 size={13} /> TODAY</span>
              <small>只在本地轻轻记一笔</small>
            </div>
            <div className="shared-drawer-today-list">
              {todayActivities.map((activity) => (
                <div key={activity.id}>
                  <span>{activity.characterName || "角色"}</span>
                  <strong>{activity.label}</strong>
                  <time>{formatSharedDrawerDate(activity.createdAt)}</time>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {filtered.length === 0 ? (
          <section className="shared-drawer-empty">
            <PackageOpen size={34} strokeWidth={1.25} />
            <strong>这一格还是空的</strong>
            <p>从手记、日历、影院或游戏里手动挑一件值得留下的东西吧。</p>
          </section>
        ) : (
          <section className="shared-drawer-grid">
            {filtered.map((item, index) => (
              <article key={item.id} className="shared-drawer-card" data-type={item.type} style={{ "--drawer-index": index } as React.CSSProperties}>
                <button type="button" className="shared-drawer-card-main" onClick={() => setSelected(item)}>
                  <span className="shared-drawer-card-icon"><ItemIcon type={item.type} /></span>
                  <span className="shared-drawer-card-copy">
                    <strong>{item.title}</strong>
                    <small>{sourceLabel(item)} · {formatSharedDrawerDate(item.createdAt)}</small>
                  </span>
                  <span className="shared-drawer-card-end">
                    {item.pinned ? <Pin className="shared-drawer-pin" size={12} fill="currentColor" /> : null}
                    <ChevronRight className="shared-drawer-chevron" size={16} aria-hidden="true" />
                  </span>
                </button>
              </article>
            ))}
          </section>
        )}

        {cinemaCollectibles.length > 0 ? (
          <section className="shared-drawer-candidates" aria-label="可收藏的票根">
            <div className="shared-drawer-section-heading">
              <span><Ticket size={13} /> 可收录票根</span>
              <small>只有真正散场的影片会出现</small>
            </div>
            {cinemaCollectibles.map((ticket) => (
              <div className="shared-drawer-candidate" key={ticket.id}>
                <div>
                  <strong>{ticket.title}</strong>
                  <span>{ticket.subtitle || formatSharedDrawerDate(ticket.createdAt)}</span>
                </div>
                <button type="button" onClick={() => handleCollectCinema(ticket)}>收进抽屉</button>
              </div>
            ))}
          </section>
        ) : null}
      </main>

      {selected ? (
        <div className="shared-drawer-overlay" role="presentation" onClick={() => setSelected(null)}>
          <article className="shared-drawer-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="shared-drawer-detail-top">
              <span>{TYPE_LABELS[selected.type]} / {sourceLabel(selected)}</span>
              <button type="button" onClick={() => setSelected(null)} aria-label="关闭">×</button>
            </div>
            <div className="shared-drawer-detail-icon"><ItemIcon type={selected.type} /></div>
            <h2>{selected.title}</h2>
            {selected.subtitle ? <p className="shared-drawer-detail-subtitle">{selected.subtitle}</p> : null}
            {selected.note ? <p className="shared-drawer-detail-note">{selected.note}</p> : null}
            {selected.characterNames?.length ? (
              <p className="shared-drawer-detail-people">WITH · {selected.characterNames.join(" / ")}</p>
            ) : null}
            <time>{formatSharedDrawerDate(selected.createdAt)}</time>
            <div className="shared-drawer-detail-actions">
              {selected.sourceApp !== "shared_drawer" && onOpenSource ? (
                <button type="button" className="is-source" onClick={() => onOpenSource(selected.sourceApp)}>
                  <ArrowUpRight size={15} />打开{sourceLabel(selected)}
                </button>
              ) : null}
              <button type="button" onClick={() => handlePin(selected)}><Pin size={15} />{selected.pinned ? "取消固定" : "别针固定"}</button>
              <button type="button" className="is-danger" onClick={() => handleDelete(selected)}><Trash2 size={15} />移出抽屉</button>
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
