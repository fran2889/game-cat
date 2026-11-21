import { useState, type CSSProperties } from "react";
import { Box, Image } from "@mantine/core";
import { coverUrl, hashHue, initialsFor, type CoverArt } from "../format.ts";

export interface GameCoverProps {
  appId: number;
  name: string;
  className?: string;
  /** Grid cards use the portrait capsule; detail and table keep the header. */
  art?: CoverArt;
}

/**
 * Store art is derived from the App ID, never API data. Library capsules are
 * not universal, so a missing capsule retries the landscape header before the
 * tinted initials fallback takes over.
 *
 * The hue is per-Game, so the fallback tint stays inline; everything else is
 * Mantine's `Image` and `Box`.
 */
export function GameCover({
  appId,
  name,
  className = "game-cover",
  art = "header",
}: GameCoverProps) {
  const [libraryFailed, setLibraryFailed] = useState(false);
  const [headerFailed, setHeaderFailed] = useState(false);
  const hue = hashHue(name);
  const tint = { "--cover-h": String(hue) } as CSSProperties;
  const useLibrary = art === "library" && !libraryFailed;
  const failed = useLibrary ? false : headerFailed;

  if (failed) {
    return (
      <Box
        className={`${className} game-cover-fallback`}
        style={tint}
        aria-hidden="true"
        data-cover-fallback="true"
      >
        {initialsFor(name)}
      </Box>
    );
  }

  return (
    <Image
      className={className}
      src={coverUrl(appId, useLibrary ? "library" : "header")}
      alt=""
      loading="lazy"
      fit="cover"
      style={tint}
      onError={() => {
        if (useLibrary) {
          setLibraryFailed(true);
        } else {
          setHeaderFailed(true);
        }
      }}
    />
  );
}
