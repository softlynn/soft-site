import { useEffect, useState, useRef } from "react";
import { Box, Typography, Tooltip, useMediaQuery, IconButton, Collapse, Divider, Button, Link } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CustomPlayer from "./CustomPlayer";
import Chat from "./Chat";
import Chapters from "./VodChapters";
import ExpandMore from "../utils/CustomExpandMore";
import CustomWidthTooltip from "../utils/CustomToolTip";
import NotFound from "../utils/NotFound";
import { toHMS, convertTimestamp } from "../utils/helpers";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HomeIcon from "@mui/icons-material/Home";
import { BRAND_NAME } from "../config/site";
import { getVodById } from "../api/vodsApi";

const getOriginalTwitchVodUrl = (vod) => {
  if (!vod || String(vod.platform || "").toLowerCase() !== "twitch") return "";
  if (vod.unpublished) return "";
  if (vod.twitchExists === false || vod.twitchDeleted === true || vod.twitchUnavailable === true) return "";
  if (typeof vod.twitchStatus === "string" && ["deleted", "unpublished", "private", "missing"].includes(vod.twitchStatus.toLowerCase())) return "";
  if (vod.twitch && typeof vod.twitch === "object" && vod.twitch.exists === false) return "";
  const id = String(vod.id || "").trim();
  if (!/^\d+$/.test(id)) return "";
  return `https://www.twitch.tv/videos/${id}`;
};

export default function Vod(props) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const { vodId } = useParams();
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
  const [userChatDelay, setUserChatDelay] = useState(0);
  const playerRef = useRef(null);

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
    console.info(`Chat Delay: ${userChatDelay + delay} seconds`);
    return;
  }, [userChatDelay, delay]);

  useEffect(() => {
    if (!playerRef.current) return;
    if (timestamp >= 0) {
      //need to pause/play to reset chat position.
      playerRef.current.pause();
      playerRef.current.currentTime(timestamp);
      playerRef.current.play();
    }
  }, [timestamp, playerRef]);

  const copyTimestamp = () => {
    navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${location.pathname}?t=${toHMS(currentTime)}`);
  };

  if (vod === undefined || drive === undefined) return <Loading />;
  if (vod === null) return <NotFound />;
  const originalTwitchVodUrl = getOriginalTwitchVodUrl(vod);

  return (
    <Box sx={{ height: "100%", width: "100%", p: { xs: 0.75, md: 1 } }}>
      <Box sx={{ display: "flex", flexDirection: isPortrait ? "column" : "row", height: "100%", width: "100%" }}>
        <Box
          className="soft-glass"
          sx={{
            display: "flex",
            height: "100%",
            width: "100%",
            flexDirection: "column",
            alignItems: "flex-start",
            minWidth: 0,
            overflow: "hidden",
            position: "relative",
            borderRadius: "20px",
            p: 0.6,
          }}
        >
          <Box sx={{ width: "100%", height: "100%", borderRadius: "16px", overflow: "hidden", background: "#000", minHeight: 0 }}>
            <CustomPlayer playerRef={playerRef} setCurrentTime={setCurrentTime} setPlaying={setPlaying} delay={delay} setDelay={setDelay} type={type} vod={vod} timestamp={timestamp} />
          </Box>
          <Box sx={{ position: "absolute", bottom: 0, left: "50%" }}>
            <Tooltip title={showMenu ? "Collapse" : "Expand"}>
              <ExpandMore expand={showMenu} onClick={handleExpandClick} aria-expanded={showMenu} aria-label="show menu">
                <ExpandMoreIcon />
              </ExpandMore>
            </Tooltip>
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
              {chapter && <Chapters chapters={vod.chapters} chapter={chapter} setChapter={setChapter} setTimestamp={setTimestamp} />}
              <Box sx={{ minWidth: 0 }}>
                <CustomWidthTooltip title={vod.title}>
                  <Typography fontWeight={550} variant="body1" noWrap={true}>{`${vod.title}`}</Typography>
                </CustomWidthTooltip>
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
              <Button
                variant="outlined"
                size="small"
                startIcon={<HomeIcon />}
                onClick={() => navigate("/vods")}
                sx={{ ml: 1, whiteSpace: "nowrap", borderRadius: "12px" }}
              >
                Home
              </Button>
              <Box sx={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                <Box sx={{ ml: 0.5 }}>
                  {drive && drive[0] && (
                    <Tooltip title={`Download Vod`}>
                      <IconButton href={`https://drive.google.com/u/2/open?id=${drive[0].id}`} color="secondary" aria-label="Download Vod" rel="noopener noreferrer" target="_blank">
                        <DownloadIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
                <Box sx={{ ml: 0.5 }}>
                  <Tooltip title={`Copy Current Timestamp`}>
                    <IconButton onClick={copyTimestamp} color="primary" aria-label="Copy Current Timestamp" rel="noopener noreferrer" target="_blank">
                      <ContentCopyIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            </Box>
          </Collapse>
        </Box>
        {isPortrait && <Divider sx={{ my: 0.6, borderColor: "rgba(19,33,56,0.08)" }} />}
        {
          <Chat
            isPortrait={isPortrait}
            vodId={vodId}
            playerRef={playerRef}
            playing={playing}
            currentTime={currentTime}
            delay={delay}
            userChatDelay={userChatDelay}
            setUserChatDelay={setUserChatDelay}
          />
        }
      </Box>
    </Box>
  );
}
