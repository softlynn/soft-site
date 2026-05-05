import { Box, Typography, Grid, Button } from "@mui/material";
import Thumbnail from "../assets/default_thumbnail.png";
import Chapters from "./ChaptersMenu";
import CustomWidthTooltip from "../utils/CustomToolTip";
import { useMemo } from "react";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";
import { Link } from "react-router-dom";
import VodReactions from "./VodReactions";
import { useSiteDesign } from "../design/DesignContext";

dayjs.extend(localizedFormat);

const DEFAULT_CARD_WIDTH = "20.75rem";

export default function Vod(props) {
  const { vod, gridSize, sizes, sheen = false, cardWidth } = props;
  const { design } = useSiteDesign();
  const settings = design?.settings || {};
  const resolvedCardWidth = cardWidth || DEFAULT_CARD_WIDTH;
  const hasPlayableVod = Array.isArray(vod.youtube) && vod.youtube.length > 0;
  const watchHref = `/youtube/${vod.id}`;
  const vodAccent = String(settings.vodAccentColor || settings.accentColor || "#d46b8c");
  const vodCardStyle = String(settings.vodCardStyle || "bubble");
  const thumbnailShape = String(settings.vodThumbnailShape || "soft");
  const thumbnailOverlay = String(settings.vodThumbnailOverlay || "clean");
  const thumbnailRadius = thumbnailShape === "bubble" ? 26 : thumbnailShape === "round" ? 22 : 18;
  const watchLabel = String(settings.vodWatchLabel || "Watch").trim() || "Watch";

  const thumbnail = useMemo(() => {
    if (vod.youtube?.length > 0) return vod.youtube[0].thumbnail_url;
    if (vod.games?.length > 0) return vod.games[0].thumbnail_url;
    return vod.thumbnail_url || Thumbnail;
  }, [vod]);

  const vodPartCount = useMemo(
    () =>
      (Array.isArray(vod?.youtube) ? vod.youtube : []).filter(
        (part) => String(part?.type || "vod") === "vod" && part?.id
      ).length,
    [vod]
  );

  const primaryGame = useMemo(() => {
    const gameName = vod.games?.find((game) => game?.game_name)?.game_name || vod.chapters?.find((chapter) => chapter?.name)?.name || "";
    return String(gameName || "").trim();
  }, [vod]);

  return (
    <Grid size={sizes || { xs: gridSize }} sx={{ maxWidth: resolvedCardWidth, flexBasis: resolvedCardWidth }}>
      <Box
        className={`soft-glass soft-surface-float soft-vod-card soft-vod-card--${vodCardStyle} soft-vod-card--overlay-${thumbnailOverlay}${sheen ? " soft-shimmer" : ""}`}
        sx={{
          borderRadius: vodCardStyle === "bubble" ? "28px" : "22px",
          p: vodCardStyle === "pearl" ? 0.85 : 0.95,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 0.85,
        }}
      >
        <Box
          className="soft-vod-card__media"
          component={hasPlayableVod ? Link : "div"}
          to={hasPlayableVod ? watchHref : undefined}
          sx={{
            overflow: "hidden",
            height: 0,
            paddingTop: "56.25%",
            position: "relative",
            borderRadius: `${thumbnailRadius}px`,
            cursor: hasPlayableVod ? "pointer" : "default",
            background: "var(--soft-surface)",
            border: "1px solid var(--soft-border)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 14px 28px rgba(19,33,56,0.10)",
            "& img": {
              transition: "transform 360ms cubic-bezier(.2,.8,.2,1), filter 260ms ease",
            },
            "&:hover img": {
              transform: "scale(1.055)",
              filter: "saturate(1.06) contrast(1.02)",
            },
          }}
        >
          <img
            className="thumbnail"
            alt=""
            src={thumbnail}
            loading={sheen ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={sheen ? "high" : "auto"}
          />

          <Box
            sx={{
              pointerEvents: "none",
              position: "absolute",
              inset: 0,
              background:
                thumbnailOverlay === "minimal"
                  ? "linear-gradient(180deg, rgba(19,33,56,0.00) 40%, rgba(19,33,56,0.36) 100%)"
                  : thumbnailOverlay === "glow"
                    ? `radial-gradient(220px 140px at 18% 12%, ${vodAccent}33, transparent 66%), linear-gradient(180deg, rgba(19,33,56,0.02) 20%, rgba(19,33,56,0.58) 100%)`
                    : "linear-gradient(180deg, rgba(19,33,56,0.00) 30%, rgba(19,33,56,0.46) 100%)",
              borderRadius: "inherit",
            }}
          />

          <Box sx={{ position: "absolute", top: 10, left: 10 }}>
            <Box
              className="soft-vod-card__metachip"
              sx={{
                px: 0.92,
                py: 0.36,
                borderRadius: "999px",
                background: `linear-gradient(180deg, ${vodAccent}f2, ${vodAccent}d8)`,
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.34)",
                boxShadow: `0 10px 18px ${vodAccent}42`,
                display: "flex",
                alignItems: "center",
                gap: 0.5,
              }}
            >
              <PlayArrowRoundedIcon sx={{ fontSize: 15, color: "inherit" }} />
              <Typography variant="caption" sx={{ color: "inherit", fontWeight: 850, letterSpacing: "0.02em" }}>
                {watchLabel}
              </Typography>
            </Box>
          </Box>

          {vodPartCount > 1 && (
            <Box sx={{ position: "absolute", top: 10, right: 10 }}>
              <Box
                className="soft-vod-card__metachip"
                sx={{
                  px: 1,
                  py: 0.45,
                  borderRadius: "999px",
                  background: "rgba(19, 33, 56, 0.70)",
                  color: "rgba(255,255,255,0.96)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  boxShadow: "0 10px 18px rgba(7, 10, 24, 0.28)",
                }}
              >
                <Typography variant="caption" sx={{ fontWeight: 800, lineHeight: 1 }}>
                  {vodPartCount} Parts
                </Typography>
              </Box>
            </Box>
          )}

          <Box sx={{ position: "absolute", bottom: 10, left: 10, right: 10, display: "flex", justifyContent: "space-between", gap: 1 }}>
            <Typography
              variant="caption"
              className="soft-vod-card__metachip"
              sx={{
                px: 0.72,
                py: 0.26,
                borderRadius: "9px",
                backgroundColor: "rgba(18,29,50,.58)",
                color: "rgba(255,255,255,0.95)",
                backdropFilter: "blur(8px)",
                fontSize: "0.66rem",
              }}
            >
              {dayjs(vod.createdAt).format("LL")}
            </Typography>
            <Typography
              variant="caption"
              className="soft-vod-card__metachip"
              sx={{
                px: 0.72,
                py: 0.26,
                borderRadius: "9px",
                backgroundColor: "rgba(18,29,50,.58)",
                color: "rgba(255,255,255,0.95)",
                display: "flex",
                alignItems: "center",
                gap: 0.35,
                backdropFilter: "blur(8px)",
                fontSize: "0.66rem",
              }}
            >
              <AccessTimeRoundedIcon sx={{ fontSize: 13 }} />
              {vod.duration}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
          {vod.chapters && vod.chapters.length > 0 && <Chapters vod={vod} />}

          <Box sx={{ minWidth: 0, width: "100%", pr: 0.15 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.45, minWidth: 0 }}>
              <CustomWidthTooltip title={vod.title} placement="top">
                <Button
                  className="soft-vod-card__titlebtn"
                  component={hasPlayableVod ? Link : "button"}
                  to={hasPlayableVod ? watchHref : undefined}
                  sx={{
                    width: "auto",
                    flex: 1,
                    minWidth: 0,
                    justifyContent: "flex-start",
                    textAlign: "left",
                    px: 0.65,
                    py: 0.45,
                    borderRadius: "12px",
                    "&:hover": {
                      background: "rgba(255,255,255,0.58)",
                    },
                  }}
                  size="small"
                  disabled={!hasPlayableVod}
                >
                  <Typography
                    fontWeight={700}
                    variant="body2"
                    color="primary"
                    noWrap
                    sx={{ width: "100%", textAlign: "left", lineHeight: 1.24, letterSpacing: 0 }}
                  >
                    {vod.title}
                  </Typography>
                </Button>
              </CustomWidthTooltip>

              <VodReactions vodId={vod.id} countOnlyLike readOnly compact sx={{ ml: "auto" }} />
            </Box>
            {settings.vodShowGame !== false && primaryGame && (
              <Box sx={{ px: 0.7, mt: 0.15, display: "flex", alignItems: "center", gap: 0.45, color: "text.secondary", minWidth: 0 }}>
                <SportsEsportsRoundedIcon sx={{ fontSize: 14, color: vodAccent }} />
                <Typography variant="caption" noWrap sx={{ fontWeight: 750, letterSpacing: 0, minWidth: 0 }}>
                  {primaryGame}
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Grid>
  );
}
