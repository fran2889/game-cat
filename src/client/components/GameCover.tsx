import { useState, type CSSProperties } from "react";
import { coverUrl, hashHue, initialsFor } from "../format.ts";

export interface GameCoverProps {
  appId: number;
  name: string;
  className?: string;
}

/**
 * Store art is derived from the App ID, never API data. If the CDN is
 * unreachable the tinted initials fallback carries the same identity.
 */
export function GameCover({ appId, name, className = "game-cover" }: GameCoverProps) {
  const [failed, setFailed] = useState(false);
  const hue = hashHue(name);
  const tint = { "--cover-h": String(hue) } as CSSProperties;

  if (failed) {
    return (
      <div
        className={`${className} game-cover-fallback`}
        style={tint}
        aria-hidden="true"
        data-cover-fallback="true"
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <img
      className={className}
      src={coverUrl(appId)}
      alt=""
      loading="lazy"
      style={tint}
      onError={() => setFailed(true)}
    />
  );
}
