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

const delay = 0;
const getOriginalTwitchVodUrl = (vod) => {
  if (!vod || String(vod.platform || "").toLowerCase() !== "twitch") return "";
  const id = String(vod.id || "").trim();
  if (!/^\d+$/.test(id)) return "";
  return `https://www.twitch.tv/videos/${id}`;
};

export default function Games(props) {
  const location = useLocation();
  const isPortrait = useMediaQuery("(orientation: portrait)");
  const { vodId } = useParams();
  const [vod, setVod] = useState(undefined);
  const [games, setGames] = useState(undefined);
  const [drive, setDrive] = useState(undefined);
  const [part, setPart] = useState(undefined);
  const [showMenu, setShowMenu] = useState(true);
  const [playing, setPlaying] = useState({ playing: false });
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
    setDrive(vod.drive.filter((data) => data.type === "vod"));
    setGames(vod.games);
    const search = new URLSearchParams(location.search);
    let tmpPart = search.get("part") !== null ? parseInt(search.get("part")) : 1;
    setPart({ part: tmpPart, timestamp: 0 });
    return;
  }, [vod, location.search]);

  const handlePartChange = (evt) => {
    const tmpPart = evt.target.value + 1;
    setPart({ part: tmpPart, timestamp: 0 });
  };

  const handleExpandClick = () => {
    setShowMenu(!showMenu);
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
            <YoutubePlayer playerRef={playerRef} part={part} games={games} setPart={setPart} setPlaying={setPlaying} delay={delay} />
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
              </Box>
            </Box>
          </Collapse>
        </Box>
        {isPortrait && <Divider sx={{ my: 0.6, borderColor: "rgba(19,33,56,0.08)" }} />}
        <Chat
          isPortrait={isPortrait}
          vodId={vodId}
          playerRef={playerRef}
          playing={playing}
          delay={delay}
          userChatDelay={userChatDelay}
          part={part}
          setPart={setPart}
          games={games}
          setUserChatDelay={setUserChatDelay}
        />
      </Box>
    </Box>
  );
}
