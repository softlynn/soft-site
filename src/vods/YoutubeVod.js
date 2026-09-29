import { useContext, useEffect, useState, useRef } from "react";
import { Box, Typography, MenuItem, Tooltip, useMediaQuery, FormControl, Select, IconButton, Collapse, Button, Grid } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useNavigate, useParams } from "react-router";
import YoutubePlayer from "./YoutubePlayer";
import DownloadIcon from "@mui/icons-material/Download";
import NotFound from "../utils/NotFound";
import Chat from "./Chat";
import Chapters from "./VodChapters";
import ViewerHeader from "./ViewerHeader";
import { toHMS, convertTimestamp } from "../utils/helpers";
import CopyTimestampButton from "./CopyTimestampButton";
import HomeIcon from "@mui/icons-material/Home";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
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

export default function Vod(props) {
  const { themeMode, setThemeMode } = useContext(ThemeModeContext);
  const location = useLocation();
  const navigate = useNavigate();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const isMobile = useMediaQuery("(max-width:1024px), (hover: none) and (pointer: coarse)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
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
  const showViewerBar = useStackedMobileLayout || chatVisible;

  return (
    <Box
      className="soft-vod-watch-shell soft-viewer-page"
      data-mobile={isMobile}
      data-fullscreen={mobileViewerFullscreen}
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
        className="soft-viewer-content"
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
          className="soft-viewer-layout"
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
            className="soft-vod-viewer-panel soft-viewer-player-column"
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
            }}
          >
            {!showViewerBar && (
              <Tooltip title="Back home">
                <IconButton className="soft-viewer-home-overlay" onClick={() => navigate("/")} aria-label="Back home" disableRipple={reducedMotion}
                  sx={{ position: "absolute", top: mobileViewerFullscreen ? "max(env(safe-area-inset-top), 10px)" : 10,
                    left: mobileViewerFullscreen ? "calc(max(env(safe-area-inset-left), 10px) + 52px)" : 10,
                    zIndex: 6, width: 44, height: 44 }}>
                  <HomeIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {isMobile && (
              <Tooltip title={mobileViewerFullscreen ? "Exit fullscreen viewer" : "Open fullscreen with chat"}>
                <IconButton
                  className="soft-viewer-fullscreen"
                  disableRipple={reducedMotion}
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
                overflow: "hidden",
              }}
            >
              <Box
                className="soft-player-frame"
                sx={{
                  width: useStackedMobileLayout ? "100%" : "auto",
                  height: useStackedMobileLayout ? "auto" : "100%",
                  maxWidth: "100%",
                  maxHeight: "100%",
                  aspectRatio: "16 / 9",
                  overflow: "hidden",
                  background: "#080b12",
                  minHeight: 0,
                  position: "relative",
                  zIndex: 2,
                }}
              >
                <YoutubePlayer playerRef={playerRef} part={part} youtube={youtube} setCurrentTime={setCurrentTime} setPart={setPart} setPlaying={setPlaying} />
              </Box>
            </Box>

            <Collapse className="soft-viewer-shelf-collapse" in={showViewerBar} timeout={reducedMotion ? 0 : 220} unmountOnExit sx={{ minHeight: "auto !important", width: "100%" }}>
              <Box className="soft-viewer-shelf">
                <ViewerHeader vod={vod} game={chapter?.name} sourceUrl={originalTwitchVodUrl} isMobile={isMobile} />
                <Box className="soft-vod-viewer-controls soft-viewer-controls">
                  <Box className="soft-viewer-controls-primary">
                    {chapter && <Box className="soft-viewer-chapter-control"><Chapters chapters={vod.chapters} chapter={chapter} setPart={setPart} youtube={youtube} setChapter={setChapter} /></Box>}
                  {hasMultipleVodParts && (
                    <FormControl
                      className="soft-viewer-part-control"
                      variant="standard"
                      size="small"
                    >
                      <Select disableUnderline value={part.part - 1} onChange={handlePartChange}
                        inputProps={{ "aria-label": "Part" }}
                        renderValue={(value) => `Part ${youtube[value]?.part || value + 1} / ${youtube.length}`}>
                        {youtube.map((data, index) => (
                          <MenuItem key={data.id} value={index} disableRipple={reducedMotion}>
                            {data?.part || index + 1}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                  </Box>
                  <Box className="soft-viewer-controls-secondary">
                  {drive?.[0] && (
                    <Tooltip title="Download VOD">
                      <IconButton className="soft-viewer-download" disableRipple={reducedMotion} href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download VOD" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <CopyTimestampButton disabled={!timelineAvailable || !Number.isFinite(currentTime)}
                    url={Number.isFinite(currentTime) ? `${window.location.origin}${location.pathname}?t=${toHMS(currentTime)}` : ""} />
                  <Box className="soft-viewer-reactions"><VodReactions vodId={vod.id} compact viewerControls lazy={false} /></Box>
                  </Box>
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
          <Box component="section" className="soft-viewer-below" sx={{ width: "100%", maxWidth: 1760, mx: "auto", pb: 4 }}>
            {vod.description && (
              <details className="soft-viewer-description">
                <summary>About this stream</summary>
                <p>{vod.description}</p>
              </details>
            )}

            {recommendedVods.length > 0 && (
              <Box className="soft-vod-recommendations soft-viewer-recommendations">
                <Box className="soft-viewer-recommendations-heading">
                  <Typography component="h2" variant="h5">
                    More from {BRAND_NAME}
                  </Typography>
                  <Button className="soft-viewer-archive-link" variant="text" disableRipple={reducedMotion} onClick={() => navigate("/vods")}>
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
