import { useState } from "react";
import { Box } from "@mui/material";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";

export default function ChapterArtwork({ image, width = 40, height = 53, borderRadius = 0 }) {
  // Older chapter records contain the Twitch artwork size template.
  const source = typeof image === "string" ? image.trim().replace("{width}x{height}", "40x53") : "";
  const [failedSource, setFailedSource] = useState("");
  const showImage = Boolean(source && source !== failedSource);

  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: "inline-flex",
        width,
        height,
        flexShrink: 0,
        borderRadius,
        overflow: "hidden",
        verticalAlign: "middle",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: showImage ? "transparent" : "action.hover",
        color: "text.secondary",
      }}
    >
      {showImage ? (
        <img
          key={source}
          alt=""
          src={source}
          onError={() => setFailedSource(source)}
          style={{ display: "block", width: "100%", height: "100%" }}
        />
      ) : (
        <SportsEsportsRoundedIcon sx={{ fontSize: Math.min(width, height) * 0.6, opacity: 0.65 }} />
      )}
    </Box>
  );
}
