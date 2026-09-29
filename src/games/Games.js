import { useEffect, useState, useRef } from "react";
import { Box, MenuItem, Tooltip, useMediaQuery, FormControl, Select, IconButton, Link, Collapse, Divider } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useParams } from "react-router";
import YoutubePlayer from "./Youtube";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import NotFound from "../utils/NotFound";
import Chat from "../vods/Chat";
import ExpandMore from "../utils/CustomExpandMore";
import ViewerHeader from "../vods/ViewerHeader";
import { BRAND_NAME, DEFAULT_CHAT_DELAY_SECONDS } from "../config/site";
import { getVodById } from "../api/vodsApi";
import VodReactions from "../vods/VodReactions";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import { getStoredChatDelaySeconds, setStoredChatDelaySeconds } from "../vods/chatDelayPreference";
import { resolvePlaybackPosition } from "../vods/replayUtils.mjs";

const delay = 0;
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

export default function Games(props) {
  const location = useLocation();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const isMobile = useMediaQuery("(max-width:1024px), (hover: none) and (pointer: coarse)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { vodId } = useParams();
  const [vod, setVod] = useState(undefined);
  const [games, setGames] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [part, setPart] = useState(undefined);
  const [showMenu, setShowMenu] = useState(true);
  const [playing, setPlaying] = useState({ playing: false });
  const [userChatDelay, setUserChatDelay] = useState(() => getStoredChatDelaySeconds() ?? DEFAULT_CHAT_DELAY_SECONDS);
  const [mobileFullscreenChat, setMobileFullscreenChat] = useState(false);
  const [mobileViewportSize, setMobileViewportSize] = useState({ width: 0, height: 0 });
  const playerRef = useRef(null);
  const mobileViewerFullscreen = isMobile && mobileFullscreenChat;
  const mobileViewportLooksLandscape =
    mobileViewportSize.width > 0 &&
    mobileViewportSize.height > 0 &&
    mobileViewportSize.width > mobileViewportSize.height;
  const mobileFullscreenSideLayout = mobileViewerFullscreen && (mobileViewportLooksLandscape || !isPortrait);
  const useStackedMobileLayout = mobileViewerFullscreen ? !mobileFullscreenSideLayout : isPortrait;
  const fullscreenViewportHeight = mobileViewerFullscreen
    ? mobileViewportSize.height
      ? `${mobileViewportSize.height}px`
      : "100svh"
    : "100%";
  const fullscreenViewportWidth = mobileViewerFullscreen
    ? mobileViewportSize.width
      ? `${mobileViewportSize.width}px`
      : "100vw"
    : "100%";

  useEffect(() => {
    let disposed = false;
    setVod(undefined);
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
    setDrive(vod.drive.filter((data) => data.type === "vod"));
    setGames(vod.games);
    const search = new URLSearchParams(location.search);
    setPart(resolvePlaybackPosition(vod.games.map((game, index) => ({ ...game, part: index + 1 })), search.get("part")));
    return;
  }, [vod, location.search]);

  useEffect(() => {
    if (!isMobile && mobileFullscreenChat) {
      setMobileFullscreenChat(false);
    }
  }, [isMobile, mobileFullscreenChat]);

  useEffect(() => {
    if (!mobileViewerFullscreen) return;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [mobileViewerFullscreen]);

  useEffect(() => {
    if (!mobileViewerFullscreen) return;

    let raf = null;
    let settleTimer = null;
    const applyViewportSize = () => {
      const vv = window.visualViewport;
      const width = Math.round((vv && vv.width) || window.innerWidth || 0);
      const height = Math.round((vv && vv.height) || window.innerHeight || 0);
      setMobileViewportSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    const queueApply = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(applyViewportSize);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(applyViewportSize, 220);
    };

    queueApply();
    window.addEventListener("resize", queueApply);
    window.addEventListener("orientationchange", queueApply);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", queueApply);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
      window.removeEventListener("resize", queueApply);
      window.removeEventListener("orientationchange", queueApply);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", queueApply);
      }
    };
  }, [mobileViewerFullscreen]);

  const handlePartChange = (evt) => {
    const tmpPart = evt.target.value + 1;
    setPart({ part: tmpPart, timestamp: 0 });
  };

  const handleExpandClick = () => {
    setShowMenu(!showMenu);
  };

  const handleMobileFullscreenChatToggle = () => {
    if (!isMobile) return;
    setMobileFullscreenChat((prev) => !prev);
  };

  useEffect(() => {
    console.info(`Chat Delay (effective): ${delay - userChatDelay} seconds`);
    return;
  }, [userChatDelay]);

  useEffect(() => {
    setStoredChatDelaySeconds(userChatDelay);
  }, [userChatDelay]);

  if (vod === null) return <NotFound />;
  if (vod === undefined || drive === undefined || part === undefined || games === undefined) return <Loading />;

  if (games.length === 0) return <NotFound />;
  const originalTwitchVodUrl = getOriginalTwitchVodUrl(vod);

  return (
    <Box
      className="soft-vod-watch-shell soft-game-watch-shell soft-viewer-page"
      data-mobile={isMobile}
      data-fullscreen={mobileViewerFullscreen}
      sx={{
        height: fullscreenViewportHeight,
        width: fullscreenViewportWidth,
        p: mobileViewerFullscreen
          ? "max(env(safe-area-inset-top), 6px) max(env(safe-area-inset-right), 6px) max(env(safe-area-inset-bottom), 6px) max(env(safe-area-inset-left), 6px)"
          : { xs: 0.75, md: 1 },
        boxSizing: "border-box",
        minHeight: 0,
        position: mobileViewerFullscreen ? "fixed" : "relative",
        inset: mobileViewerFullscreen ? 0 : "auto",
        zIndex: mobileViewerFullscreen ? 1400 : "auto",
        background: mobileViewerFullscreen ? "rgba(8, 12, 20, 0.84)" : "transparent",
        backdropFilter: mobileViewerFullscreen ? "blur(6px)" : "none",
      }}
    >
      <Box className="soft-viewer-layout" sx={{ display: "flex", flexDirection: mobileFullscreenSideLayout ? "row" : isPortrait ? "column" : "row", height: "100%", width: "100%", gap: mobileFullscreenSideLayout ? 0.6 : 0 }}>
        <Box
          className="soft-vod-viewer-panel soft-viewer-player-column"
          sx={{
            display: "flex",
            height: "100%",
            width: mobileFullscreenSideLayout ? "auto" : "100%",
            flex: "1 1 auto",
            flexDirection: "column",
            alignItems: "flex-start",
            minWidth: 0,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <Box
            className="soft-player-stage"
            sx={{
              width: "100%",
              minHeight: 0,
              flex: 1,
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
              <YoutubePlayer playerRef={playerRef} part={part} games={games} setPart={setPart} setPlaying={setPlaying} delay={delay} />
            </Box>
          </Box>
          <Box
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
              <ExpandMore expand={showMenu} disableRipple={reducedMotion} onClick={handleExpandClick} aria-expanded={showMenu} aria-label="show menu" sx={{ width: isMobile ? 44 : 34, height: isMobile ? 44 : 34 }}>
                <ExpandMoreIcon />
              </ExpandMore>
            </Tooltip>
            {isMobile && (
              <Tooltip title={mobileViewerFullscreen ? "Exit Fullscreen + Chat" : "Open Fullscreen + Chat (Overlay)"}>
                <IconButton
                  className="soft-viewer-fullscreen"
                  disableRipple={reducedMotion}
                  onClick={handleMobileFullscreenChatToggle}
                  aria-label={mobileViewerFullscreen ? "Exit fullscreen with chat" : "Open fullscreen with chat"}
                  sx={{ width: 44, height: 44, ml: 0.15 }}
                >
                  {mobileViewerFullscreen ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <Collapse className="soft-viewer-shelf-collapse" in={showMenu} timeout={reducedMotion ? 0 : "auto"} unmountOnExit sx={{ minHeight: "auto !important", width: "100%" }}>
            <Box className="soft-viewer-shelf">
              <ViewerHeader vod={vod} game={games[part.part - 1]?.game_name} sourceUrl={originalTwitchVodUrl} isMobile={isMobile} />
              <Box className="soft-vod-viewer-controls soft-viewer-controls">
                <Box className="soft-viewer-controls-primary">
                  <FormControl className="soft-viewer-part-control" variant="standard" size="small">
                    <Select disableUnderline value={part.part - 1} onChange={handlePartChange} autoWidth
                      inputProps={{ "aria-label": "Game" }}
                      renderValue={(value) => `Game ${value + 1} / ${games.length}`}>
                      {games.map((data, i) => {
                        return (
                          <MenuItem key={data.id} value={i} disableRipple={reducedMotion}>
                            {data.game_name}
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>
                </Box>
                <Box className="soft-viewer-controls-secondary">
                  {drive && drive[0] && (
                    <Tooltip title={`Download Vod`}>
                      <IconButton className="soft-viewer-download" disableRipple={reducedMotion} component={Link} href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download Vod" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Box className="soft-viewer-reactions"><VodReactions vodId={vod.id} compact viewerControls lazy={false} /></Box>
                </Box>
              </Box>
            </Box>
          </Collapse>
        </Box>
        {useStackedMobileLayout && <Divider sx={{ my: 0.6, borderColor: "rgba(19,33,56,0.08)" }} />}
        <Chat
          isPortrait={useStackedMobileLayout}
          vodId={vodId}
          playerRef={playerRef}
          playing={playing}
          delay={delay}
          userChatDelay={userChatDelay}
          part={part}
          setPart={setPart}
          games={games}
          setUserChatDelay={setUserChatDelay}
          forceSideLayout={mobileFullscreenSideLayout}
          mobileControls={isMobile}
        />
      </Box>
    </Box>
  );
}
