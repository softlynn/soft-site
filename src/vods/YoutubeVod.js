import { useContext, useEffect, useState, useRef } from "react";
import { Box, Typography, MenuItem, Tooltip, useMediaQuery, FormControl, InputLabel, Select, IconButton, Collapse, Button, Grid, Stack } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useNavigate, useParams } from "react-router";
import YoutubePlayer from "./YoutubePlayer";
import DownloadIcon from "@mui/icons-material/Download";
import NotFound from "../utils/NotFound";
import Chat from "./Chat";
import Chapters from "./VodChapters";
import CustomToolTip from "../utils/CustomToolTip";
import { toHMS, convertTimestamp } from "../utils/helpers";
import CopyTimestampButton from "./CopyTimestampButton";
import HomeIcon from "@mui/icons-material/Home";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import { BRAND_NAME, DEFAULT_CHAT_DELAY_SECONDS } from "../config/site";
import { getVodById } from "../api/vodsApi";
import VodReactions from "./VodReactions";
import { getStoredChatDelaySeconds, setStoredChatDelaySeconds } from "./chatDelayPreference";
import useMobileViewer from "./useMobileViewer";
import { getPlaybackTime, resolvePlaybackPosition } from "./replayUtils.mjs";
import vodsClient from "./client";
import VodCard from "./Vod";
import SimpleBar from "simplebar-react";
import { ThemeModeContext } from "../utils/ThemeModeContext";

const VIEWER_THEME_STORAGE_KEY = "softu-vod-viewer-theme";

const getOriginalTwitchVodUrl = (vod) => {
  if (!vod || String(vod.platform || "").toLowerCase() !== "twitch") return "";
  if (vod.unpublished) return "";
  if (vod.twitchPublished === false) return "";
  if (vod.twitchUnpublished === true) return "";
  if (vod.twitchExists === false || vod.twitchDeleted === true || vod.twitchUnavailable === true) return "";
  if (vod.twitch && typeof vod.twitch === "object" && (vod.twitch.published === false || vod.twitch.unpublished === true)) return "";
  if (vod.twitch && typeof vod.twitch === "object" && (vod.twitch.deleted === true || vod.twitch.available === false)) return "";
  if (typeof vod.twitchStatus === "string" && ["deleted", "unpublished", "private", "missing"].includes(vod.twitchStatus.toLowerCase())) return "";
  if (typeof vod.originalTwitchStatus === "string" && ["deleted", "unpublished", "private", "missing"].includes(vod.originalTwitchStatus.toLowerCase())) return "";
  if (vod.twitch && typeof vod.twitch === "object" && vod.twitch.exists === false) return "";
  const id = String(vod.id || "").trim();
  if (!/^\d+$/.test(id)) return "";
  return `https://www.twitch.tv/videos/${id}`;
};

const buildArchiveRecommendations = (vods, currentVodId, limit = 4) => {
  const archive = (Array.isArray(vods) ? vods : [])
    .filter((candidate) => Array.isArray(candidate?.youtube) && candidate.youtube.some((entry) => entry?.id))
    .sort((a, b) => {
      const dateDifference = new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime();
      return dateDifference || String(b?.id || "").localeCompare(String(a?.id || ""));
    });
  const currentIndex = archive.findIndex((candidate) => String(candidate?.id) === String(currentVodId));
  if (currentIndex < 0) return archive.filter((candidate) => String(candidate?.id) !== String(currentVodId)).slice(0, limit);
  if (currentIndex === 0) return archive.slice(1, limit + 1);

  const recommendations = [];
  const addCandidate = (candidate) => {
    if (!candidate || String(candidate.id) === String(currentVodId)) return;
    if (recommendations.some((item) => String(item.id) === String(candidate.id))) return;
    recommendations.push(candidate);
  };

  addCandidate(archive[0]);
  if (currentIndex > 1) addCandidate(archive[currentIndex - 1]);
  addCandidate(archive[currentIndex + 1]);
  addCandidate(archive[currentIndex + 2]);

  for (let distance = 1; recommendations.length < limit && distance < archive.length; distance += 1) {
    addCandidate(archive[currentIndex + distance]);
    addCandidate(archive[currentIndex - distance]);
  }
  for (const candidate of archive) {
    if (recommendations.length >= limit) break;
    addCandidate(candidate);
  }

  return recommendations.slice(0, limit);
};

const formatVodDate = (value) => {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date);
};

export default function Vod(props) {
  const { themeMode, setThemeMode } = useContext(ThemeModeContext);
  const location = useLocation();
  const navigate = useNavigate();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const isMobile = useMediaQuery("(max-width:1024px), (hover: none) and (pointer: coarse)");
  const params = useParams();
  const vodId = props.vodId || params.vodId || params.pageSlug;
  const { type } = props;
  const [vod, setVod] = useState(undefined);
  const [youtube, setYoutube] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [chapter, setChapter] = useState(undefined);
  const [part, setPart] = useState(undefined);
  const [chatVisible, setChatVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(undefined);
  const [playing, setPlaying] = useState({ playing: false });
  const [userChatDelay, setUserChatDelay] = useState(() => getStoredChatDelaySeconds() ?? DEFAULT_CHAT_DELAY_SECONDS);
  const [recommendedVods, setRecommendedVods] = useState([]);
  const playerRef = useRef(null);
  const themeBeforeViewerRef = useRef(themeMode);
  const { mobileViewerFullscreen, mobileFullscreenSideLayout, useStackedMobileLayout,
    fullscreenViewportHeight, fullscreenViewportWidth, toggleFullscreen: handleMobileFullscreenChatToggle } = useMobileViewer({ isMobile, isPortrait });

  useEffect(() => {
    const themeBeforeViewer = themeBeforeViewerRef.current;
    let savedViewerTheme;
    try { savedViewerTheme = window.localStorage.getItem(VIEWER_THEME_STORAGE_KEY); } catch { /* Optional viewer preference. */ }
    setThemeMode(savedViewerTheme === "light" ? "light" : "dark");
    return () => {
      setThemeMode(themeBeforeViewer);
    };
  }, [setThemeMode]);

  useEffect(() => {
    let disposed = false;
    setVod(undefined);
    setYoutube(undefined);
    setDrive(undefined);
    setPlaying({ playing: false });
    const fetchVod = async () => {
      await getVodById(vodId)
        .then((response) => {
          if (disposed) return;
          setVod(response);
          document.title = `${response.title || response.id} - ${BRAND_NAME}`;
        })
        .catch((e) => {
          if (disposed) return;
          console.error(e);
          setVod(null);
        });
    };
    fetchVod();
    return () => { disposed = true; };
  }, [vodId]);

  useEffect(() => {
    if (!vod) return;
    const useType = type || (vod.youtube.some((entry) => entry.type === "live") ? "live" : "vod");
    const videos = vod.youtube.filter((data) => (data.type || "vod") === useType)
      .map((data, index) => ({ ...data, part: index + 1 }));
    setYoutube(videos);
    setDrive(vod.drive.filter((data) => (data.type || "vod") === useType));
    const search = new URLSearchParams(location.search);
    const timestamp = search.get("t") !== null ? convertTimestamp(search.get("t")) : 0;
    setPart(resolvePlaybackPosition(videos, search.get("part"), timestamp));
    setChapter(vod.chapters ? vod.chapters[0] : null);
    return;
  }, [vod, type, location.search]);

  useEffect(() => {
    if (!vod?.id) return undefined;
    let active = true;

    vodsClient
      .service("vods")
      .find({
        query: {
          $limit: 200,
          $skip: 0,
          $sort: { createdAt: -1 },
          $and: [{ unpublished: { $ne: true } }],
        },
      })
      .then((response) => {
        if (!active) return;
        const archive = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
        setRecommendedVods(buildArchiveRecommendations(archive, vod.id, 4));
      })
      .catch(() => {
        if (active) setRecommendedVods([]);
      });

    return () => {
      active = false;
    };
  }, [vod?.id]);

  useEffect(() => {
    if (!playerRef.current || !vod || !vod.chapters) return;
    for (let chapter of vod.chapters) {
      if (currentTime > chapter.start && currentTime < chapter.start + chapter.end) {
        setChapter(chapter);
        break;
      }
    }
    return;
  }, [currentTime, vod, playerRef]);

  useEffect(() => {
    setCurrentTime(undefined);
  }, [part, youtube]);

  const handlePartChange = (evt) => {
    const tmpPart = evt.target.value + 1;
    setPart({ part: tmpPart, timestamp: 0 });
  };

  const handleViewerThemeModeChange = (mode) => {
    const nextMode = mode === "light" ? "light" : "dark";
    try { window.localStorage.setItem(VIEWER_THEME_STORAGE_KEY, nextMode); } catch { /* Optional viewer preference. */ }
    setThemeMode(nextMode);
  };

  useEffect(() => {
    setStoredChatDelaySeconds(userChatDelay);
  }, [userChatDelay]);

  if (vod === null) return <NotFound />;
  if (vod === undefined || drive === undefined || part === undefined || youtube === undefined) return <Loading />;

  if (youtube.length === 0) return <NotFound />;
  const timelineAvailable = getPlaybackTime(youtube, part.part, 0) !== null;
  const totalVodParts = youtube.filter((data) => String(data?.type || "vod") === "vod" && data?.id).length;
  const hasMultipleVodParts = totalVodParts > 1;
  const originalTwitchVodUrl = getOriginalTwitchVodUrl(vod);
  const vodDate = formatVodDate(vod.createdAt);
  const vodTopics = Array.from(
    new Set(
      (Array.isArray(vod.chapters) ? vod.chapters : [])
        .map((item) => String(item?.name || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 3);
  const showViewerBar = useStackedMobileLayout || chatVisible;

  return (
    <Box
      className="soft-vod-watch-shell"
      sx={{
        height: fullscreenViewportHeight,
        width: fullscreenViewportWidth,
        boxSizing: "border-box",
        minHeight: 0,
        overflow: "hidden",
        position: mobileViewerFullscreen ? "fixed" : "relative",
        inset: mobileViewerFullscreen ? 0 : "auto",
        zIndex: mobileViewerFullscreen ? 1200 : "auto",
        background: mobileViewerFullscreen ? "rgba(8, 12, 20, 0.84)" : "transparent",
        backdropFilter: mobileViewerFullscreen ? "blur(6px)" : "none",
        ...(mobileViewerFullscreen && { "& .soft-vod-watch-scroll .simplebar-content": { height: "100%" } }),
      }}
    >
      <SimpleBar className="soft-vod-watch-scroll" style={{ height: "100%", width: "100%" }} autoHide>
      <Box
        sx={{
          minHeight: "100%",
          height: mobileViewerFullscreen ? "100%" : undefined,
          p: mobileViewerFullscreen
            ? "max(env(safe-area-inset-top), 4px) max(env(safe-area-inset-right), 4px) max(env(safe-area-inset-bottom), 4px) max(env(safe-area-inset-left), 4px)"
            : isMobile ? "max(env(safe-area-inset-top), 4px) max(env(safe-area-inset-right), 4px) max(env(safe-area-inset-bottom), 4px) max(env(safe-area-inset-left), 4px)" : { xs: 0.35, md: 0.5 },
          boxSizing: "border-box",
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: mobileFullscreenSideLayout ? "row" : useStackedMobileLayout ? "column" : "row",
            height: mobileViewerFullscreen
              ? "100%"
                : useStackedMobileLayout
                  ? "auto"
                  : isMobile
                    ? "max(280px, calc(100dvh - 8px))"
                  : chatVisible
                  ? "clamp(520px, calc(56.25vw - 112px), calc(100dvh - 8px))"
                  : "clamp(520px, calc(56.25vw - 12px), calc(100dvh - 8px))",
            minHeight: mobileViewerFullscreen || useStackedMobileLayout || isMobile ? 0 : 520,
            width: "100%",
            maxWidth: 1920,
            mx: "auto",
            gap: { xs: 0.4, md: 0.55 },
            transition: "none",
          }}
        >
          <Box
            className="soft-glass soft-vod-viewer-panel"
            sx={{
              display: "flex",
              height: useStackedMobileLayout ? "auto" : "100%",
              width: mobileFullscreenSideLayout ? "auto" : "100%",
              flex: useStackedMobileLayout ? "0 0 auto" : "1 1 auto",
              flexDirection: "column",
              alignItems: "flex-start",
              minWidth: 0,
              overflow: "hidden",
              position: "relative",
              borderRadius: { xs: "14px", md: "18px" },
              p: 0.35,
              gap: 0.3,
            }}
          >
            {isMobile && (
              <Tooltip title={mobileViewerFullscreen ? "Exit fullscreen viewer" : "Open fullscreen with chat"}>
                <IconButton
                  onClick={handleMobileFullscreenChatToggle}
                  aria-label={mobileViewerFullscreen ? "Exit fullscreen viewer" : "Open fullscreen with chat"}
                  sx={{
                    position: mobileViewerFullscreen ? "fixed" : "absolute",
                    top: mobileViewerFullscreen ? "max(env(safe-area-inset-top), 10px)" : 10,
                    left: mobileViewerFullscreen ? "max(env(safe-area-inset-left), 10px)" : "auto",
                    right: mobileViewerFullscreen ? "auto" : 10,
                    zIndex: mobileViewerFullscreen ? 1201 : 6,
                    width: 44,
                    height: 44,
                    color: "var(--soft-text-primary)",
                    background: "var(--soft-control-strip-bg)",
                    border: "1px solid var(--soft-control-strip-border)",
                    boxShadow: "var(--soft-control-strip-inset), 0 8px 20px rgba(2,6,18,0.16)",
                    "&:hover": { background: "var(--soft-control-strip-bg)" },
                  }}
                >
                  {mobileViewerFullscreen ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            )}

            <Box
              className="soft-player-stage"
              sx={{
                width: "100%",
                minHeight: 0,
                flex: useStackedMobileLayout ? "0 0 auto" : 1,
                aspectRatio: useStackedMobileLayout ? "16 / 9" : "auto",
                display: "grid",
                placeItems: "center",
                position: "relative",
                borderRadius: { xs: "12px", md: "16px" },
                overflow: "hidden",
              }}
            >
              <Box
                aria-hidden="true"
                sx={{
                  position: "absolute",
                  inset: 0,
                  background: "#111214",
                  zIndex: 1,
                }}
              />

              <Box
                className="soft-player-frame"
                sx={{
                  width: useStackedMobileLayout ? "100%" : "auto",
                  height: useStackedMobileLayout ? "auto" : "100%",
                  maxWidth: "100%",
                  maxHeight: "100%",
                  aspectRatio: "16 / 9",
                  borderRadius: { xs: "12px", md: "16px" },
                  overflow: "hidden",
                  background: "#080b12",
                  minHeight: 0,
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05), 0 18px 44px rgba(2,6,18,0.18)",
                  position: "relative",
                  zIndex: 2,
                }}
              >
                <YoutubePlayer playerRef={playerRef} part={part} youtube={youtube} setCurrentTime={setCurrentTime} setPart={setPart} setPlaying={setPlaying} />
              </Box>
            </Box>

            <Collapse in={showViewerBar} timeout={220} unmountOnExit sx={{ minHeight: "auto !important", width: "100%" }}>
              <Box
                className="soft-vod-viewer-controls"
                sx={{
                  display: "flex",
                  flexWrap: isMobile ? "wrap" : "nowrap",
                  gap: 0.6,
                  p: { xs: 0.65, sm: 0.8 },
                  alignItems: "center",
                  borderRadius: "14px",
                  background: "var(--soft-control-strip-bg)",
                  border: "1px solid var(--soft-control-strip-border)",
                  boxShadow: "var(--soft-control-strip-inset)",
                  mx: 0.25,
                  mb: 0.15,
                  ...(isMobile && {
                    "& button, & a.MuiIconButton-root, & .MuiSelect-select": { minWidth: 44, minHeight: 44, boxSizing: "border-box" },
                    "& .MuiSelect-select": { display: "flex", alignItems: "center", py: 0 },
                  }),
                }}
              >
                <Tooltip title="Back home">
                  <IconButton onClick={() => navigate("/")} aria-label="Back home" sx={{ flex: "0 0 auto" }}>
                    <HomeIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                {chapter && <Chapters chapters={vod.chapters} chapter={chapter} setPart={setPart} youtube={youtube} setChapter={setChapter} />}
                <Box sx={{ minWidth: 0, flex: isMobile ? "1 0 100%" : "1 1 220px", order: isMobile ? -1 : 0, pb: isMobile ? 0.4 : 0 }}>
                  <CustomToolTip title={vod.title} disableInteractive={isMobile} disableHoverListener={isMobile}>
                    <Typography fontWeight={650} variant="body1" noWrap={!isMobile} sx={isMobile ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere", lineHeight: 1.4 } : undefined}>{vod.title}</Typography>
                  </CustomToolTip>
                  <Stack direction="row" spacing={0.8} alignItems="center">
                    {vodDate && (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {vodDate}
                      </Typography>
                    )}
                    {vod.vodNotice && (
                      <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 650 }} noWrap>
                        {vod.vodNotice}
                      </Typography>
                    )}
                  </Stack>
                </Box>

                <Box sx={{ ml: "auto", display: isMobile ? "contents" : "flex", alignItems: "center", gap: 0.35 }}>
                  {hasMultipleVodParts && (
                    <FormControl
                      variant="outlined"
                      size="small"
                      sx={{
                        minWidth: 82,
                        "& .MuiOutlinedInput-root": {
                          boxShadow: "0 0 0 1px rgba(212,107,140,0.18), 0 0 16px rgba(212,107,140,0.14)",
                        },
                      }}
                    >
                      <InputLabel id="select-label">Part</InputLabel>
                      <Select labelId="select-label" label="Part" value={part.part - 1} onChange={handlePartChange}>
                        {youtube.map((data, index) => (
                          <MenuItem key={data.id} value={index}>
                            {data?.part || index + 1}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                  {drive?.[0] && (
                    <Tooltip title="Download VOD">
                      <IconButton href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download VOD" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <CopyTimestampButton disabled={!timelineAvailable || !Number.isFinite(currentTime)}
                    url={Number.isFinite(currentTime) ? `${window.location.origin}${location.pathname}?t=${toHMS(currentTime)}` : ""} />
                  <VodReactions vodId={vod.id} compact viewerControls lazy={false} sx={{ ml: 0.25 }} />
                </Box>
              </Box>
            </Collapse>
          </Box>

          <Chat
            isPortrait={useStackedMobileLayout}
            vodId={vodId}
            chatReplayAvailable={vod.chatReplayAvailable !== false && timelineAvailable}
            playerRef={playerRef}
            playing={playing}
            delay={0}
            userChatDelay={userChatDelay}
            youtube={youtube}
            part={part}
            setPart={setPart}
            setUserChatDelay={setUserChatDelay}
            forceSideLayout={mobileFullscreenSideLayout}
            mobileControls={isMobile}
            fillAvailable={mobileViewerFullscreen && useStackedMobileLayout}
            showChat={useStackedMobileLayout ? true : chatVisible}
            onShowChatChange={setChatVisible}
            confirmLightMode
            onThemeModeChange={handleViewerThemeModeChange}
          />
        </Box>

        {!mobileViewerFullscreen && (
          <Box component="section" sx={{ width: "100%", maxWidth: 1760, mx: "auto", px: { xs: 0.15, sm: 0.5, md: 0.75 }, pt: { xs: 1.25, md: 1.75 }, pb: 4 }}>
            <Box
              className="soft-glass soft-vod-viewer-details"
              sx={{
                borderRadius: { xs: "18px", md: "24px" },
                p: { xs: 1.5, sm: 2, md: 2.5 },
                display: "flex",
                alignItems: { xs: "flex-start", md: "center" },
                flexDirection: { xs: "column", md: "row" },
                gap: 2,
              }}
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="overline" sx={{ color: "secondary.main", fontWeight: 800, letterSpacing: "0.12em" }}>
                  Now watching
                </Typography>
                <Typography variant="h4" sx={{ mt: 0.25, lineHeight: 1.12, color: "primary.main" }}>
                  {vod.title}
                </Typography>
                <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" sx={{ mt: 1.25 }}>
                  {[vodDate, vod.duration, `${totalVodParts} ${totalVodParts === 1 ? "part" : "parts"}`, ...vodTopics]
                    .filter(Boolean)
                    .map((label) => (
                      <Box
                        key={label}
                        sx={{
                          px: 1.05,
                          py: 0.45,
                          borderRadius: "999px",
                          color: "text.secondary",
                          background: "rgba(255,255,255,0.36)",
                          border: "1px solid var(--soft-border)",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                        }}
                      >
                        {label}
                      </Box>
                    ))}
                </Stack>
                {vod.description && (
                  <Typography variant="body2" sx={{ mt: 1.25, maxWidth: 900, color: "text.secondary", whiteSpace: "pre-wrap" }}>
                    {vod.description}
                  </Typography>
                )}
              </Box>

              <Stack direction={{ xs: "row", md: "column" }} spacing={0.8} useFlexGap flexWrap="wrap">
                <Button variant="contained" startIcon={<VideoLibraryRoundedIcon />} onClick={() => navigate("/vods")}>
                  Browse archive
                </Button>
                {originalTwitchVodUrl && (
                  <Button component="a" href={originalTwitchVodUrl} target="_blank" rel="noopener noreferrer" variant="outlined">
                    Open Twitch VOD
                  </Button>
                )}
              </Stack>
            </Box>

            {recommendedVods.length > 0 && (
              <Box className="soft-vod-recommendations" sx={{ mt: { xs: 2.5, md: 3.5 } }}>
                <Box sx={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: 2, mb: 1.2, px: 0.5 }}>
                  <Typography variant="h5" sx={{ color: "primary.main", lineHeight: 1.1 }}>
                    Recommended
                  </Typography>
                  <Button variant="text" onClick={() => navigate("/vods")}>
                    View all
                  </Button>
                </Box>
                <Grid container spacing={{ xs: 1.2, sm: 1.6, md: 2 }} sx={{ justifyContent: "center" }}>
                  {recommendedVods.map((recommendedVod, index) => (
                    <VodCard
                      key={recommendedVod.id}
                      vod={recommendedVod}
                      sizes={{ xs: 12, sm: 6, lg: 3 }}
                      gridSize={3}
                      sheen={index === 0}
                      cardWidth="100%"
                    />
                  ))}
                </Grid>
              </Box>
            )}
          </Box>
        )}
      </Box>
      </SimpleBar>
    </Box>
  );
}
