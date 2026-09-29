import { useEffect, useState, useRef } from "react";
import { Box, Tooltip, useMediaQuery, IconButton, Collapse } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useNavigate, useParams } from "react-router";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CustomPlayer from "./CustomPlayer";
import Chat from "./Chat";
import Chapters from "./VodChapters";
import ExpandMore from "../utils/CustomExpandMore";
import ViewerHeader from "./ViewerHeader";
import NotFound from "../utils/NotFound";
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

export default function Vod(props) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const isMobile = useMediaQuery("(max-width:1024px), (hover: none) and (pointer: coarse)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const params = useParams();
  const vodId = props.vodId || params.vodId || params.pageSlug;
  const { type } = props;
  const [vod, setVod] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [chapter, setChapter] = useState(undefined);
  const [showMenu, setShowMenu] = useState(true);
  const [currentTime, setCurrentTime] = useState(undefined);
  const [playing, setPlaying] = useState({ playing: false });
  const search = new URLSearchParams(location.search);
  const [timestamp, setTimestamp] = useState(search.get("t") !== null ? convertTimestamp(search.get("t")) : 0);
  const [delay, setDelay] = useState(0);
  const [userChatDelay, setUserChatDelay] = useState(() => getStoredChatDelaySeconds() ?? DEFAULT_CHAT_DELAY_SECONDS);
  const playerRef = useRef(null);
  const { mobileViewerFullscreen, mobileFullscreenSideLayout, useStackedMobileLayout,
    fullscreenViewportHeight, fullscreenViewportWidth, toggleFullscreen: handleMobileFullscreenChatToggle } = useMobileViewer({ isMobile, isPortrait });

  useEffect(() => {
    let disposed = false;
    setVod(undefined);
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
    setDrive(vod.drive.filter((data) => data.type === "live"));
    setChapter(vod.chapters ? vod.chapters[0] : null);
    return;
  }, [vod, type, location.search]);

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

  const handleExpandClick = () => {
    setShowMenu(!showMenu);
  };

  useEffect(() => {
    if (delay === undefined) return;
    console.info(`Chat Delay (effective): ${delay - userChatDelay} seconds`);
    return;
  }, [userChatDelay, delay]);

  useEffect(() => {
    setStoredChatDelaySeconds(userChatDelay);
  }, [userChatDelay]);

  useEffect(() => {
    if (!playerRef.current) return;
    if (timestamp >= 0) {
      //need to pause/play to reset chat position.
      playerRef.current.pause();
      playerRef.current.currentTime(timestamp);
      playerRef.current.play();
    }
  }, [timestamp, playerRef]);

  if (vod === null) return <NotFound />;
  if (vod === undefined || drive === undefined) return <Loading />;
  const originalTwitchVodUrl = getOriginalTwitchVodUrl(vod);

  return (
    <Box
      className="soft-vod-watch-shell soft-custom-watch-shell soft-viewer-page soft-viewer-content"
      data-mobile={isMobile}
      data-fullscreen={mobileViewerFullscreen}
      sx={{
        height: fullscreenViewportHeight,
        width: fullscreenViewportWidth,
        p: mobileViewerFullscreen
          ? "max(env(safe-area-inset-top), 6px) max(env(safe-area-inset-right), 6px) max(env(safe-area-inset-bottom), 6px) max(env(safe-area-inset-left), 6px)"
          : isMobile ? "max(env(safe-area-inset-top), 6px) max(env(safe-area-inset-right), 6px) max(env(safe-area-inset-bottom), 6px) max(env(safe-area-inset-left), 6px)" : { xs: 0.75, md: 1 },
        boxSizing: "border-box",
        minHeight: 0,
        overflowY: isMobile ? "auto" : undefined,
        position: mobileViewerFullscreen ? "fixed" : "relative",
        inset: mobileViewerFullscreen ? 0 : "auto",
        zIndex: mobileViewerFullscreen ? 1200 : "auto",
        background: mobileViewerFullscreen ? "rgba(8, 12, 20, 0.84)" : "transparent",
        backdropFilter: mobileViewerFullscreen ? "blur(6px)" : "none",
      }}
    >
      <Box className="soft-viewer-layout" sx={{ display: "flex", flexDirection: useStackedMobileLayout ? "column" : "row", height: mobileViewerFullscreen || !useStackedMobileLayout ? "100%" : "auto", minHeight: mobileViewerFullscreen ? "100%" : 0, width: "100%", gap: mobileFullscreenSideLayout ? 0.6 : 0 }}>
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
          {!isMobile && !showMenu && <Tooltip title="Back home">
            <IconButton
              className="soft-viewer-home-overlay"
              disableRipple={reducedMotion}
              onClick={() => navigate("/")}
              aria-label="Back home"
              sx={{
                position: "absolute",
                top: { xs: 10, md: 12 },
                left: { xs: 10, md: 12 },
                zIndex: 6,
                width: 44,
                height: 44,
              }}
            >
              <HomeIcon fontSize="small" />
            </IconButton>
          </Tooltip>}
          {isMobile && (
            <Tooltip title={mobileViewerFullscreen ? "Exit fullscreen viewer" : "Open fullscreen with chat"}>
              <IconButton className="soft-viewer-fullscreen" disableRipple={reducedMotion} onClick={handleMobileFullscreenChatToggle} aria-label={mobileViewerFullscreen ? "Exit fullscreen viewer" : "Open fullscreen with chat"}
                sx={{ position: mobileViewerFullscreen ? "fixed" : "absolute", top: mobileViewerFullscreen ? "max(env(safe-area-inset-top), 10px)" : 10,
                  left: mobileViewerFullscreen ? "max(env(safe-area-inset-left), 10px)" : "auto", right: mobileViewerFullscreen ? "auto" : 10, zIndex: mobileViewerFullscreen ? 1201 : 6,
                  width: 44, height: 44 }}>
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
                width: "100%",
                maxWidth: {
                  xs: mobileFullscreenSideLayout ? `min(100%, calc((100dvh - ${showMenu ? 156 : 92}px) * 16 / 9))` : "100%",
                  md: `min(100%, calc((100dvh - ${showMenu ? 156 : 92}px) * 16 / 9))`,
                },
                maxHeight: "100%",
                aspectRatio: "16 / 9",
                overflow: "hidden",
                background: "transparent",
                minHeight: 0,
                position: "relative",
                zIndex: 2,
              }}
            >
              <CustomPlayer playerRef={playerRef} setCurrentTime={setCurrentTime} setPlaying={setPlaying} delay={delay} setDelay={setDelay} type={type} vod={vod} timestamp={timestamp} />
            </Box>
          </Box>
          {!isMobile && <Box
            className="soft-viewer-controls-toggle"
            sx={{
              position: "absolute",
              bottom: showMenu ? 8 : 10,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 4,
            }}
          >
            <Tooltip title={showMenu ? "Collapse" : "Expand"}>
              <ExpandMore expand={showMenu} disableRipple={reducedMotion} onClick={handleExpandClick} aria-expanded={showMenu} aria-label="show menu" sx={{ width: 34, height: 34 }}>
                <ExpandMoreIcon />
              </ExpandMore>
            </Tooltip>
          </Box>}
          <Collapse className="soft-viewer-shelf-collapse" in={isMobile || showMenu} timeout={reducedMotion ? 0 : "auto"} unmountOnExit sx={{ minHeight: "auto !important", width: "100%" }}>
            <Box className="soft-viewer-shelf">
              <ViewerHeader vod={vod} game={chapter?.name} sourceUrl={originalTwitchVodUrl} isMobile={isMobile} />
              <Box className="soft-vod-viewer-controls soft-viewer-controls">
                <Box className="soft-viewer-controls-primary">
                  {chapter && <Box className="soft-viewer-chapter-control"><Chapters chapters={vod.chapters} chapter={chapter} setChapter={setChapter} setTimestamp={setTimestamp} /></Box>}
                </Box>
                <Box className="soft-viewer-controls-secondary">
                  {drive && drive[0] && (
                    <Tooltip title={`Download Vod`}>
                      <IconButton className="soft-viewer-download" disableRipple={reducedMotion} href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download Vod" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <CopyTimestampButton disabled={!Number.isFinite(currentTime)}
                    url={Number.isFinite(currentTime) ? `${window.location.origin}${location.pathname}?t=${toHMS(currentTime)}` : ""} />
                  <Box className="soft-viewer-reactions"><VodReactions vodId={vod.id} compact viewerControls lazy={false} /></Box>
                </Box>
              </Box>
            </Box>
          </Collapse>
        </Box>
        {
          <Chat
            isPortrait={useStackedMobileLayout}
            vodId={vodId}
            playerRef={playerRef}
            playing={playing}
            currentTime={currentTime}
            delay={delay}
            userChatDelay={userChatDelay}
            setUserChatDelay={setUserChatDelay}
            forceSideLayout={mobileFullscreenSideLayout}
            mobileControls={isMobile}
            fillAvailable={mobileViewerFullscreen && useStackedMobileLayout}
          />
        }
      </Box>
    </Box>
  );
}
