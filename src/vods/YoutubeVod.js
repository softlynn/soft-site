import { useEffect, useState, useRef } from "react";
import { Box, Typography, MenuItem, Tooltip, useMediaQuery, FormControl, InputLabel, Select, IconButton, Collapse, Divider, Button } from "@mui/material";
import Loading from "../utils/Loading";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import YoutubePlayer from "./YoutubePlayer";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import NotFound from "../utils/NotFound";
import Chat from "./Chat";
import Chapters from "./VodChapters";
import ExpandMore from "../utils/CustomExpandMore";
import CustomToolTip from "../utils/CustomToolTip";
import { toHMS, convertTimestamp, toSeconds } from "../utils/helpers";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HomeIcon from "@mui/icons-material/Home";
import { BRAND_NAME, DEFAULT_DELAY } from "../config/site";
import { getVodById } from "../api/vodsApi";

export default function Vod(props) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const { vodId } = useParams();
  const { type } = props;
  const [vod, setVod] = useState(undefined);
  const [youtube, setYoutube] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [chapter, setChapter] = useState(undefined);
  const [part, setPart] = useState(undefined);
  const [showMenu, setShowMenu] = useState(true);
  const [currentTime, setCurrentTime] = useState(undefined);
  const [playing, setPlaying] = useState({ playing: false });
  const [delay, setDelay] = useState(undefined);
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
    if (!type) {
      const useType = vod.youtube.some((youtube) => youtube.type === "live") ? "live" : "vod";
      setYoutube(vod.youtube.filter((data) => data.type === useType));
      setDrive(vod.drive.filter((data) => data.type === useType));
    } else {
      setYoutube(vod.youtube.filter((data) => data.type === type));
      setDrive(vod.drive.filter((data) => data.type === type));
    }
    const search = new URLSearchParams(location.search);
    let timestamp = search.get("t") !== null ? convertTimestamp(search.get("t")) : 0;
    let tmpPart = search.get("part") !== null ? parseInt(search.get("part")) : 1;
    if (timestamp > 0) {
      for (let data of vod.youtube) {
        if (data.duration > timestamp) {
          tmpPart = data?.part || vod.youtube.indexOf(data) + 1;
          break;
        }
        timestamp -= data.duration;
      }
    }
    setPart({ part: tmpPart, timestamp: timestamp });
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

  useEffect(() => {
    if (!youtube || !vod) return;
    const vodDuration = toSeconds(vod.duration);
    let totalYoutubeDuration = 0;
    for (let data of youtube) {
      if (!data.duration) {
        totalYoutubeDuration += DEFAULT_DELAY;
        continue;
      }
      totalYoutubeDuration += data.duration;
    }
    const tmpDelay = vodDuration - totalYoutubeDuration < 0 ? 0 : vodDuration - totalYoutubeDuration;
    setDelay(tmpDelay);
    return;
  }, [youtube, vod]);

  const handlePartChange = (evt) => {
    const tmpPart = evt.target.value + 1;
    setPart({ part: tmpPart, duration: 0 });
  };

  const handleExpandClick = () => {
    setShowMenu(!showMenu);
  };

  useEffect(() => {
    if (delay === undefined) return;
    console.info(`Chat Delay: ${userChatDelay + delay} seconds`);
    return;
  }, [userChatDelay, delay]);

  const copyTimestamp = () => {
    navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${location.pathname}?t=${toHMS(currentTime)}`);
  };

  if (vod === undefined || drive === undefined || part === undefined || delay === undefined) return <Loading />;
  if (vod === null) return <NotFound />;

  if (youtube.length === 0) return <NotFound />;

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
          <YoutubePlayer playerRef={playerRef} part={part} youtube={youtube} setCurrentTime={setCurrentTime} setPart={setPart} setPlaying={setPlaying} delay={delay} />
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
                background: "rgba(255,255,255,0.62)",
                border: "1px solid rgba(255,255,255,0.7)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.82)",
                mx: 0.4,
                mb: 0.2,
              }}
            >
              {chapter && <Chapters chapters={vod.chapters} chapter={chapter} setPart={setPart} youtube={youtube} setChapter={setChapter} />}
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
                  <FormControl variant="outlined">
                    <InputLabel id="select-label">Part</InputLabel>
                    <Select labelId="select-label" label="Part" value={part.part - 1} onChange={handlePartChange} autoWidth>
                      {youtube.map((data, i) => {
                        return (
                          <MenuItem key={data.id} value={i}>
                            {data?.part || i + 1}
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>
                </Box>
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
        <Chat
          isPortrait={isPortrait}
          vodId={vodId}
          chatReplayAvailable={vod.chatReplayAvailable !== false}
          playerRef={playerRef}
          playing={playing}
          delay={delay}
          userChatDelay={userChatDelay}
          youtube={youtube}
          part={part}
          setPart={setPart}
          setUserChatDelay={setUserChatDelay}
        />
      </Box>
    </Box>
  );
}
