"use client";

import type { CSSProperties } from "react";

export type CompanionAtlasIconName =
  | "ticket" | "note" | "gift" | "artwork" | "plant"
  | "stamp" | "keepsake" | "film" | "music" | "archive"
  | "chat" | "group" | "add-friend" | "photo" | "document"
  | "video" | "microphone" | "red-envelope" | "transfer" | "location";

const POSITIONS: Record<CompanionAtlasIconName, [number, number]> = {
  ticket: [0, 0], note: [1, 0], gift: [2, 0], artwork: [3, 0], plant: [4, 0],
  stamp: [0, 1], keepsake: [1, 1], film: [2, 1], music: [3, 1], archive: [4, 1],
  chat: [0, 2], group: [1, 2], "add-friend": [2, 2], photo: [3, 2], document: [4, 2],
  video: [0, 3], microphone: [1, 3], "red-envelope": [2, 3], transfer: [3, 3], location: [4, 3],
};

export function CompanionAtlasIcon({ name, size = 32, className = "" }: {
  name: CompanionAtlasIconName;
  size?: number;
  className?: string;
}) {
  const [column, row] = POSITIONS[name];
  const style = {
    width: size,
    height: size,
    backgroundPosition: `${column * 25}% ${row * (100 / 3)}%`,
  } as CSSProperties;
  return <span aria-hidden="true" className={`companion-atlas-icon ${className}`.trim()} data-atlas-icon={name} style={style} />;
}
