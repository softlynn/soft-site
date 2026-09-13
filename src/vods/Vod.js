import { Box, Typography, Grid, Button, IconButton } from "@mui/material";
import Thumbnail from "../assets/default_thumbnail.png";
import Chapters from "./ChaptersMenu";
import CustomWidthTooltip from "../utils/CustomToolTip";
import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import VolumeOffRoundedIcon from "@mui/icons-material/VolumeOffRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";
import { Link } from "react-router";
import VodReactions from "./VodReactions";
import { useSiteDesign } from "../design/DesignContext";

dayjs.extend(localizedFormat);

const DEFAULT_CARD_WIDTH = "20.75rem";
const HOVER_PREVIEW_DELAY_MS = 500;

const safeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw || /^javascript:/i.test(raw)) return "";
  return raw;
};

const youtubeThumbnailCandidates = (entry) => {
  const id = String(entry?.id || "").trim();
  if (!id) return [];
  return [
    `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`,
    safeUrl(entry?.thumbnail_url),
  ].filter(Boolean);
};

const getThumbnailCandidates = (vod) => {
  const youtube = Array.isArray(vod?.youtube) ? vod.youtube : [];
  const games = Array.isArray(vod?.games) ? vod.games : [];
  const candidates = [
    ...youtube.flatMap(youtubeThumbnailCandidates),
    safeUrl(vod?.thumbnail_url),
    ...games.map((game) => safeUrl(game?.thumbnail_url)),
    Thumbnail,
  ].filter(Boolean);

  return Array.from(new Set(candidates));
};

const getPrimaryYoutubeId = (vod) =>
  String(
    (Array.isArray(vod?.youtube) ? vod.youtube : []).find(
      (part) => String(part?.type || "vod") === "vod" && part?.id
    )?.id || ""
  ).trim();

const formatDuration = (value) => {
  const duration = String(value || "").trim();
  if (!duration) return "";
  return duration.replace(/^00:/, "").replace(/^0(?=\d:)/, "");
};

export default function Vod(props) {
  const { vod, gridSize, sizes, sheen = false, cardWidth } = props;
  const { design } = useSiteDesign();
  const settings = design?.settings || {};
  const resolvedCardWidth = cardWidth || DEFAULT_CARD_WIDTH;
  const previewVideoId = useMemo(() => getPrimaryYoutubeId(vod), [vod]);
  const hasPlayableVod = Boolean(previewVideoId);
  const watchHref = `/${vod.id}`;
  const vodAccent = String(settings.vodAccentColor || settings.accentColor || "#d38f38");
  const vodCardStyle = String(settings.vodCardStyle || "bubble");
  const thumbnailShape = String(settings.vodThumbnailShape || "soft");
  const thumbnailOverlay = String(settings.vodThumbnailOverlay || "clean");
  const thumbnailRadius = thumbnailShape === "bubble" ? 18 : thumbnailShape === "round" ? 15 : 12;
  const thumbnailCandidates = useMemo(() => getThumbnailCandidates(vod), [vod]);
  const [thumbnailIndex, setThumbnailIndex] = useState(0);
  const thumbnail = thumbnailCandidates[thumbnailIndex] || Thumbnail;
  const previewTimerRef = useRef(null);
  const previewFrameRef = useRef(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(true);

  useEffect(() => {
    setThumbnailIndex(0);
    setPreviewActive(false);
    setPreviewReady(false);
    setPreviewMuted(true);
  }, [vod?.id, thumbnailCandidates]);

  useEffect(
    () => () => {
      if (previewTimerRef.current) {
        window.clearTimeout(previewTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const pauseHiddenPreview = () => {
      if (!document.hidden) return;
      window.clearTimeout(previewTimerRef.current);
      setPreviewActive(false);
      setPreviewReady(false);
      setPreviewMuted(true);
    };
    document.addEventListener("visibilitychange", pauseHiddenPreview);
    return () => document.removeEventListener("visibilitychange", pauseHiddenPreview);
  }, []);

  const vodPartCount = useMemo(
    () =>
      (Array.isArray(vod?.youtube) ? vod.youtube : []).filter(
        (part) => String(part?.type || "vod") === "vod" && part?.id
      ).length,
    [vod]
  );

  const primaryGame = useMemo(() => {
    const gameName =
      vod.games?.find((game) => game?.game_name)?.game_name ||
      vod.chapters?.find((chapter) => chapter?.name)?.name ||
      "";
    return String(gameName || "").trim();
  }, [vod]);

  const clearPreviewTimer = () => {
    if (!previewTimerRef.current) return;
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
  };

  const startPreview = (event) => {
    if (!previewVideoId || event.pointerType === "touch") return;
    const hasHover = window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!hasHover || reduceMotion || navigator.connection?.saveData) return;

    clearPreviewTimer();
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewMuted(true);
      setPreviewReady(false);
      setPreviewActive(true);
    }, HOVER_PREVIEW_DELAY_MS);
  };

  const stopPreview = () => {
    clearPreviewTimer();
    setPreviewActive(false);
    setPreviewReady(false);
    setPreviewMuted(true);
  };

  const sendYoutubePreviewCommand = (func, args = []) => {
    previewFrameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "https://www.youtube.com"
    );
  };

  const togglePreviewMute = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const shouldMute = !previewMuted;
    if (shouldMute) {
      sendYoutubePreviewCommand("mute");
    } else {
      sendYoutubePreviewCommand("setVolume", [70]);
      sendYoutubePreviewCommand("unMute");
      sendYoutubePreviewCommand("playVideo");
    }
    setPreviewMuted(shouldMute);
  };

  const previewOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const previewSrc = previewVideoId
    ? `https://www.youtube.com/embed/${encodeURIComponent(
        previewVideoId
      )}?autoplay=1&mute=1&controls=0&disablekb=1&enablejsapi=1&fs=0&iv_load_policy=3&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(
        previewOrigin
      )}`
    : "";

  return (
    <Grid size={sizes || { xs: gridSize }} sx={{ maxWidth: `min(100%, ${resolvedCardWidth})`, flexBasis: resolvedCardWidth, minWidth: 0 }}>
      <Box
        className={`soft-glass soft-surface-float soft-vod-card soft-vod-card--${vodCardStyle} soft-vod-card--overlay-${thumbnailOverlay}`}
        sx={{
          borderRadius: vodCardStyle === "bubble" ? "20px" : "16px",
          boxShadow: "none",
          p: vodCardStyle === "pearl" ? 0.85 : 0.95,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 0.85,
        }}
      >
        <Box
          className={`soft-vod-card__media${previewActive ? " is-previewing" : ""}${previewReady ? " is-preview-ready" : ""}`}
          onPointerEnter={startPreview}
          onPointerLeave={stopPreview}
          sx={{
            overflow: "hidden",
            height: 0,
            paddingTop: "56.25%",
            position: "relative",
            borderRadius: `${thumbnailRadius}px`,
            cursor: hasPlayableVod ? "pointer" : "default",
            background: "var(--soft-surface)",
            border: "1px solid var(--soft-border)",
            boxShadow: "none",
            "& img": {
              transition: "opacity 180ms ease",
            },
            "&:hover:not(.is-previewing) img": {
              opacity: 0.94,
            },
          }}
        >
          <img
            className="thumbnail"
            alt=""
            src={thumbnail}
            onError={() => setThumbnailIndex((index) => Math.min(index + 1, thumbnailCandidates.length - 1))}
            loading={sheen ? "eager" : "lazy"}
            decoding="async"
            width="480"
            height="270"
            fetchPriority={sheen ? "high" : "auto"}
          />

          {previewActive && (
            <Box
              ref={previewFrameRef}
              className="soft-vod-card__preview"
              component="iframe"
              title={`Muted preview of ${vod.title}`}
              src={previewSrc}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              tabIndex={-1}
              onLoad={() => setPreviewReady(true)}
              sx={{
                position: "absolute",
                inset: 0,
                zIndex: 1,
                width: "100%",
                height: "100%",
                border: 0,
                pointerEvents: "none",
                opacity: previewReady ? 1 : 0,
                transition: "opacity 180ms ease",
              }}
            />
          )}

          <Box
            sx={{
              pointerEvents: "none",
              position: "absolute",
              inset: 0,
              zIndex: 2,
              background:
                thumbnailOverlay === "minimal"
                  ? "linear-gradient(180deg, transparent 62%, rgba(0,0,0,0.16) 100%)"
                  : thumbnailOverlay === "glow"
                    ? `radial-gradient(220px 140px at 18% 12%, ${vodAccent}22, transparent 66%), linear-gradient(180deg, transparent 56%, rgba(0,0,0,0.22) 100%)`
                    : "linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.18) 100%)",
              borderRadius: "inherit",
            }}
          />

          {hasPlayableVod && (
            <Box
              component={Link}
              to={watchHref}
              aria-label={`Watch ${vod.title || "video"}`}
              sx={{ position: "absolute", inset: 0, zIndex: 3, borderRadius: "inherit", "&:focus-visible": { outline: "2px solid var(--soft-text-primary)", outlineOffset: -3 } }}
            />
          )}

          {vodPartCount > 1 && (
            <Box sx={{ position: "absolute", top: 7, right: 7, zIndex: 4, pointerEvents: "none" }}>
              <Box
                className="soft-vod-card__metachip"
                sx={{
                  px: 0.68,
                  py: 0.3,
                  borderRadius: "4px",
                  background: "rgba(0, 0, 0, 0.8)",
                  color: "#fff",
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ color: "inherit", fontWeight: 600, fontSize: "0.7rem", lineHeight: 1 }}
                >
                  {vodPartCount} parts
                </Typography>
              </Box>
            </Box>
          )}

          {previewActive && previewReady && (
            <IconButton
              type="button"
              aria-label={previewMuted ? "Unmute preview" : "Mute preview"}
              onClick={togglePreviewMute}
              size="small"
              sx={{
                position: "absolute",
                left: 7,
                bottom: 7,
                zIndex: 5,
                minWidth: 34,
                height: 30,
                px: 0.8,
                gap: 0.45,
                borderRadius: "6px",
                color: "#fff",
                background: "rgba(0,0,0,0.76)",
                border: "1px solid rgba(255,255,255,0.24)",

                "&:hover": { background: "rgba(0,0,0,0.9)", transform: "none" },
              }}
            >
              {previewMuted ? <VolumeOffRoundedIcon sx={{ fontSize: 17 }} /> : <VolumeUpRoundedIcon sx={{ fontSize: 17 }} />}
              <Typography
                component="span"
                sx={{ color: "inherit", fontSize: "0.68rem", fontWeight: 600 }}
              >
                {previewMuted ? "Unmute" : "Mute"}
              </Typography>
            </IconButton>
          )}

          {vod.duration && (
            <Typography
              variant="caption"
              className="soft-vod-card__metachip"
              sx={{
                position: "absolute",
                right: 6,
                bottom: 6,
                zIndex: 4,
                pointerEvents: "none",
                px: 0.5,
                py: 0.18,
                borderRadius: "4px",
                backgroundColor: "rgba(0,0,0,0.82)",
                color: "#fff",
                                fontSize: "0.72rem",
                fontWeight: 600,
                lineHeight: 1.25,
                letterSpacing: "0.01em",
              }}
            >
              {formatDuration(vod.duration)}
            </Typography>
          )}
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
                      background: "var(--soft-surface)",
                    },
                  }}
                  size="small"
                  disabled={!hasPlayableVod}
                >
                  <Typography
                    fontWeight={600}
                    variant="body2"
                    color="primary"
                    sx={{ width: "100%", textAlign: "left", lineHeight: 1.45, letterSpacing: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.9em" }}
                  >
                    {vod.title}
                  </Typography>
                </Button>
              </CustomWidthTooltip>

              <VodReactions vodId={vod.id} countOnlyLike readOnly compact sx={{ ml: "auto" }} />
            </Box>

            <Box
              sx={{
                px: 0.7,
                mt: 0.15,
                display: "flex",
                alignItems: "center",
                gap: 0.45,
                color: "text.secondary",
                minWidth: 0,
              }}
            >
              {settings.vodShowGame !== false && primaryGame && (
                <>
                  <SportsEsportsRoundedIcon sx={{ fontSize: 14, color: vodAccent, flexShrink: 0 }} />
                  <Typography variant="caption" noWrap sx={{ fontWeight: 500, letterSpacing: 0, minWidth: 0 }}>
                    {primaryGame}
                  </Typography>
                  <Typography component="span" aria-hidden sx={{ color: "text.secondary", fontSize: "0.65rem" }}>
                    •
                  </Typography>
                </>
              )}
              <Typography
                variant="caption"
                noWrap
                sx={{
                  flexShrink: 0,
                  color: "text.secondary",
                  fontWeight: 500,
                  letterSpacing: 0,
                }}
              >
                {dayjs(vod.createdAt).format("MMM D, YYYY")}
              </Typography>
            </Box>
          </Box>
        </Box>
      </Box>
    </Grid>
  );
}
