import { useEffect, useState, useRef } from "react";
import { Box, Typography, MenuItem, Tooltip, useMediaQuery, FormControl, InputLabel, Select, IconButton, Link, Collapse, Divider } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useParams } from "react-router-dom";
import YoutubePlayer from "./Youtube";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import NotFound from "../utils/NotFound";
import Chat from "../vods/Chat";
import ExpandMore from "../utils/CustomExpandMore";
import CustomToolTip from "../utils/CustomToolTip";
import { BRAND_NAME } from "../config/site";
import { getVodById } from "../api/vodsApi";
import VodReactions from "../vods/VodReactions";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";

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
  const isMobile = useMediaQuery("(max-width:899.95px)");
  const { vodId } = useParams();
  const [vod, setVod] = useState(undefined);
  const [games, setGames] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [part, setPart] = useState(undefined);
  const [showMenu, setShowMenu] = useState(true);
  const [playing, setPlaying] = useState({ playing: false });
  const [userChatDelay, setUserChatDelay] = useState(0);
  const [mobileFullscreenChat, setMobileFullscreenChat] = useState(false);
  const playerRef = useRef(null);
  const mobileViewerFullscreen = isMobile && mobileFullscreenChat;
  const mobileFullscreenSideLayout = mobileViewerFullscreen && !isPortrait;
  const useStackedMobileLayout = !mobileFullscreenSideLayout && isPortrait;

  useEffect(() => {
    const fetchVod = async () => {
      await getVodById(vodId)
        .then((response) => {
          setVod(response);
          document.title = `${response.title || response.id} - ${BRAND_NAME}`;
        })
        .catch((e) => {
          console.error(e);
          setVod(null);
        });
    };
    fetchVod();
    return;
  }, [vodId]);

  useEffect(() => {
    if (!vod) return;
    setDrive(vod.drive.filter((data) => data.type === "vod"));
    setGames(vod.games);
    const search = new URLSearchParams(location.search);
    let tmpPart = search.get("part") !== null ? parseInt(search.get("part")) : 1;
    setPart({ part: tmpPart, timestamp: 0 });
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
    console.info(`Chat Delay: ${userChatDelay + delay} seconds`);
    return;
  }, [userChatDelay]);

  if (vod === undefined || drive === undefined || part === undefined || delay === undefined) return <Loading />;
  if (vod === null) return <NotFound />;

  if (games.length === 0) return <NotFound />;
  const originalTwitchVodUrl = getOriginalTwitchVodUrl(vod);

  return (
    <Box
      sx={{
        height: mobileViewerFullscreen ? "100dvh" : "100%",
        width: "100%",
        p: mobileViewerFullscreen ? 0.6 : { xs: 0.75, md: 1 },
        position: mobileViewerFullscreen ? "fixed" : "relative",
        inset: mobileViewerFullscreen ? 0 : "auto",
        zIndex: mobileViewerFullscreen ? 1400 : "auto",
        background: mobileViewerFullscreen ? "rgba(8, 12, 20, 0.84)" : "transparent",
        backdropFilter: mobileViewerFullscreen ? "blur(6px)" : "none",
      }}
    >
      <Box sx={{ display: "flex", flexDirection: mobileFullscreenSideLayout ? "row" : isPortrait ? "column" : "row", height: "100%", width: "100%", gap: mobileFullscreenSideLayout ? 0.6 : 0 }}>
        <Box
          className="soft-glass"
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
            borderRadius: "20px",
            p: 0.6,
            gap: 0.5,
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
              borderRadius: "16px",
              overflow: "hidden",
            }}
          >
            {!!(vod.thumbnail_url || games?.[part.part - 1]?.thumbnail_url) && (
              <Box
                aria-hidden="true"
                sx={{
                  position: "absolute",
                  inset: -12,
                  backgroundImage: `url(${vod.thumbnail_url || games?.[part.part - 1]?.thumbnail_url})`,
                  backgroundPosition: "center",
                  backgroundSize: "cover",
                  filter: "blur(28px) saturate(1.08)",
                  transform: "scale(1.06)",
                  opacity: 0.6,
                  zIndex: 0,
                }}
              />
            )}
            <Box
              aria-hidden="true"
              sx={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(120% 90% at 8% 8%, rgba(255,255,255,0.16), transparent 58%), radial-gradient(110% 90% at 92% 92%, rgba(212,107,140,0.13), transparent 64%), linear-gradient(180deg, rgba(255,255,255,0.04), rgba(17,24,39,0.04))",
                zIndex: 1,
              }}
            />
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
                borderRadius: "16px",
                overflow: "hidden",
                background: "transparent",
                minHeight: 0,
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
                position: "relative",
                zIndex: 2,
              }}
            >
              <YoutubePlayer playerRef={playerRef} part={part} games={games} setPart={setPart} setPlaying={setPlaying} delay={delay} />
            </Box>
          </Box>
          <Box
            sx={{
              position: "absolute",
              bottom: showMenu ? 8 : 10,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 4,
              borderRadius: "999px",
              background: "var(--soft-control-strip-bg)",
              border: "1px solid var(--soft-control-strip-border)",
              boxShadow: "var(--soft-control-strip-inset), 0 6px 16px rgba(2,6,18,0.14)",
              p: 0.25,
            }}
          >
            <Tooltip title={showMenu ? "Collapse" : "Expand"}>
              <ExpandMore expand={showMenu} onClick={handleExpandClick} aria-expanded={showMenu} aria-label="show menu" sx={{ width: 34, height: 34 }}>
                <ExpandMoreIcon />
              </ExpandMore>
            </Tooltip>
            {isMobile && (
              <Tooltip title={mobileViewerFullscreen ? "Exit Fullscreen + Chat" : "Fullscreen + Chat (Mobile)"}>
                <IconButton
                  onClick={handleMobileFullscreenChatToggle}
                  aria-label={mobileViewerFullscreen ? "Exit fullscreen with chat" : "Open fullscreen with chat"}
                  sx={{ width: 34, height: 34, color: "var(--soft-text-primary)", borderRadius: "999px", ml: 0.15 }}
                >
                  {mobileViewerFullscreen ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <Collapse in={showMenu} timeout="auto" unmountOnExit sx={{ minHeight: "auto !important", width: "100%" }}>
            <Box
              sx={{
                display: "flex",
                p: 1,
                alignItems: "center",
                borderRadius: "14px",
                background: "var(--soft-control-strip-bg)",
                border: "1px solid var(--soft-control-strip-border)",
                boxShadow: "var(--soft-control-strip-inset)",
                mx: 0.4,
                mb: 0.2,
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <CustomToolTip title={vod.title}>
                  <Typography fontWeight={550} variant="body1" noWrap={true}>{`${vod.title}`}</Typography>
                </CustomToolTip>
                {vod.vodNotice && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "warning.main",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.4,
                      px: 0.75,
                      py: 0.3,
                      mt: 0.2,
                      borderRadius: "999px",
                      background: "rgba(204,111,78,0.10)",
                      border: "1px solid rgba(204,111,78,0.18)",
                    }}
                  >
                    {vod.vodNotice}
                  </Typography>
                )}
                {originalTwitchVodUrl && (
                  <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mt: 0.25 }}>
                    Original Twitch VOD:{" "}
                    <Link href={originalTwitchVodUrl} target="_blank" rel="noopener noreferrer" underline="hover" color="secondary">
                      open
                    </Link>
                  </Typography>
                )}
              </Box>
              <Box sx={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                <Box sx={{ ml: 0.5 }}>
                  <FormControl variant="outlined">
                    <InputLabel id="select-label">Game</InputLabel>
                    <Select labelId="select-label" label="Game" value={part.part - 1} onChange={handlePartChange} autoWidth>
                      {games.map((data, i) => {
                        return (
                          <MenuItem key={data.id} value={i}>
                            {data.game_name}
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>
                </Box>
                <Box sx={{ ml: 0.5 }}>
                  {drive && drive[0] && (
                    <Tooltip title={`Download Vod`}>
                      <IconButton component={Link} href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download Vod" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
                <VodReactions vodId={vod.id} compact lazy={false} sx={{ ml: 0.7 }} />
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
        />
      </Box>
    </Box>
  );
}
