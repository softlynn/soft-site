import { Box, Typography, Grid, Button, IconButton } from "@mui/material";
import Thumbnail from "../assets/default_thumbnail.png";
import Chapters from "./ChaptersMenu";
import CustomWidthTooltip from "../utils/CustomToolTip";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import VolumeOffRoundedIcon from "@mui/icons-material/VolumeOffRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";
import { Link } from "react-router-dom";
import VodReactions from "./VodReactions";
import { useSiteDesign } from "../design/DesignContext";

dayjs.extend(localizedFormat);

const DEFAULT_CARD_WIDTH = "20.75rem";
const HOVER_PREVIEW_DELAY_MS = 500;
const TWITCH_PREVIEW_MAX_AGE_DAYS = 58;
let twitchPlayerScriptPromise = null;

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

const loadTwitchPlayer = () => {
  if (typeof window === "undefined") return Promise.reject(new Error("Twitch player is unavailable"));
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (twitchPlayerScriptPromise) return twitchPlayerScriptPromise;

  twitchPlayerScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-soft-twitch-player="true"]');
    const script = existing || document.createElement("script");
    const handleLoad = () => (
      window.Twitch?.Player
        ? resolve(window.Twitch)
        : reject(new Error("Twitch player failed to initialize"))
    );
    const handleError = () => reject(new Error("Twitch player failed to load"));

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (!existing) {
      script.src = "https://player.twitch.tv/js/embed/v1.js";
      script.async = true;
      script.dataset.softTwitchPlayer = "true";
      document.head.appendChild(script);
    }
  }).catch((error) => {
    twitchPlayerScriptPromise = null;
    throw error;
  });

  return twitchPlayerScriptPromise;
};

export default function Vod(props) {
  const { vod, gridSize, sizes, sheen = false, cardWidth } = props;
  const { design } = useSiteDesign();
  const settings = design?.settings || {};
  const resolvedCardWidth = cardWidth || DEFAULT_CARD_WIDTH;
  const previewVideoId = useMemo(() => getPrimaryYoutubeId(vod), [vod]);
  const hasPlayableVod = Boolean(previewVideoId);
  const twitchPreviewAvailable = useMemo(() => {
    const createdAt = dayjs(vod?.createdAt);
    return (
      String(vod?.platform || "").toLowerCase() === "twitch" &&
      /^\d+$/.test(String(vod?.id || "")) &&
      createdAt.isValid() &&
      dayjs().diff(createdAt, "day") <= TWITCH_PREVIEW_MAX_AGE_DAYS
    );
  }, [vod]);
  const previewKind = twitchPreviewAvailable ? "twitch" : previewVideoId ? "youtube" : "";
  const previewHostId = `soft-vod-preview-${useId().replace(/:/g, "")}`;
  const watchHref = `/${vod.id}`;
  const vodAccent = String(settings.vodAccentColor || settings.accentColor || "#d38f38");
  const vodCardStyle = String(settings.vodCardStyle || "bubble");
  const thumbnailShape = String(settings.vodThumbnailShape || "soft");
  const thumbnailOverlay = String(settings.vodThumbnailOverlay || "clean");
  const thumbnailRadius = thumbnailShape === "bubble" ? 26 : thumbnailShape === "round" ? 22 : 18;
  const thumbnailCandidates = useMemo(() => getThumbnailCandidates(vod), [vod]);
  const [thumbnailIndex, setThumbnailIndex] = useState(0);
  const thumbnail = thumbnailCandidates[thumbnailIndex] || Thumbnail;
  const previewTimerRef = useRef(null);
  const previewFrameRef = useRef(null);
  const previewPlayerRef = useRef(null);
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
    if (!previewActive || previewKind !== "twitch") return undefined;
    let cancelled = false;
    let player = null;

    loadTwitchPlayer()
      .then((Twitch) => {
        if (cancelled || !document.getElementById(previewHostId)) return;
        const parents = Array.from(new Set(["localhost", window.location.hostname].filter(Boolean)));
        player = new Twitch.Player(previewHostId, {
          video: `v${vod.id}`,
          parent: parents,
          autoplay: true,
          muted: true,
          controls: false,
          width: "100%",
          height: "100%",
        });
        previewPlayerRef.current = player;

        player.addEventListener(Twitch.Player.READY, () => {
          if (cancelled) return;
          try {
            player.setMuted(true);
            player.play();
          } catch {
            // The visible audio control can retry once the player is settled.
          }
          setPreviewReady(true);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewActive(false);
          setPreviewReady(false);
        }
      });

    return () => {
      cancelled = true;
      if (previewPlayerRef.current === player) previewPlayerRef.current = null;
      try {
        player?.pause?.();
        player?.destroy?.();
      } catch {
        // Twitch may already have removed its iframe.
      }
    };
  }, [previewActive, previewHostId, previewKind, vod.id]);

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
    if (!previewKind || event.pointerType === "touch") return;
    const hasHover = window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!hasHover || reduceMotion) return;

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
      "https://www.youtube-nocookie.com"
    );
  };

  const togglePreviewMute = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const shouldMute = !previewMuted;
    if (previewKind === "twitch") {
      try {
        previewPlayerRef.current?.setMuted(shouldMute);
        if (!shouldMute) previewPlayerRef.current?.play();
      } catch {
        // Keep the button responsive if the embed is still settling.
      }
    } else if (shouldMute) {
      sendYoutubePreviewCommand("mute");
    } else {
      sendYoutubePreviewCommand("setVolume", [70]);
      sendYoutubePreviewCommand("unMute");
      sendYoutubePreviewCommand("playVideo");
    }
    setPreviewMuted(shouldMute);
  };

  const previewSrc = previewVideoId
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(
        previewVideoId
      )}?autoplay=1&mute=1&controls=0&disablekb=1&enablejsapi=1&fs=0&iv_load_policy=3&playsinline=1&rel=0&modestbranding=1`
    : "";

  return (
    <Grid size={sizes || { xs: gridSize }} sx={{ maxWidth: resolvedCardWidth, flexBasis: resolvedCardWidth }}>
      <Box
        className={`soft-glass soft-surface-float soft-vod-card soft-vod-card--${vodCardStyle} soft-vod-card--overlay-${thumbnailOverlay}`}
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
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 14px 28px rgba(19,33,56,0.10)",
            "& img": {
              transition: "transform 360ms cubic-bezier(.2,.8,.2,1), filter 260ms ease, opacity 180ms ease",
            },
            "&:hover:not(.is-previewing) img": {
              transform: "scale(1.055)",
              filter: "saturate(1.06) contrast(1.02)",
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
            fetchPriority={sheen ? "high" : "auto"}
          />

          {previewActive && (
            previewKind === "twitch" ? (
              <Box
                id={previewHostId}
                className="soft-vod-card__preview"
                aria-label={`Muted preview of ${vod.title}`}
                sx={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 1,
                  opacity: previewReady ? 1 : 0,
                  transition: "opacity 180ms ease",
                  pointerEvents: "none",
                }}
              />
            ) : (
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
            )
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
              aria-label={`Watch ${vod.title}`}
              sx={{ position: "absolute", inset: 0, zIndex: 3, borderRadius: "inherit" }}
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
                  sx={{ color: "inherit", fontFamily: "Roboto, Arial, sans-serif", fontWeight: 600, fontSize: "0.7rem", lineHeight: 1 }}
                >
                  {vodPartCount} parts
                </Typography>
              </Box>
            </Box>
          )}

          {previewActive && (
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
                backdropFilter: "blur(6px)",
                "&:hover": { background: "rgba(0,0,0,0.9)", transform: "none" },
              }}
            >
              {previewMuted ? <VolumeOffRoundedIcon sx={{ fontSize: 17 }} /> : <VolumeUpRoundedIcon sx={{ fontSize: 17 }} />}
              <Typography
                component="span"
                sx={{ color: "inherit", fontFamily: "Roboto, Arial, sans-serif", fontSize: "0.68rem", fontWeight: 600 }}
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
                fontFamily: "Roboto, Arial, sans-serif",
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
                  <Typography variant="caption" noWrap sx={{ fontWeight: 750, letterSpacing: 0, minWidth: 0 }}>
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
