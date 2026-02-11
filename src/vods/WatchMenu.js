import YouTubeIcon from "@mui/icons-material/YouTube";
import { Menu, Button, Box } from "@mui/material";
import OndemandVideo from "@mui/icons-material/OndemandVideo";
import { Link as RouterLink } from "react-router-dom";

export default function WatchMenu(props) {
  const { vod, anchorEl, setAnchorEl, isCdnAvailable } = props;

  return (
    <Menu anchorEl={anchorEl} keepMounted open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
      <Box sx={{ pl: 1 }}>
        <Box>
          <Button component={RouterLink} to={`/youtube/${vod.id}`} color="primary" disabled={vod.youtube.length === 0} startIcon={<YouTubeIcon />} size="large" fullWidth sx={{ justifyContent: "flex-start" }}>
            Youtube (Vod)
          </Button>
        </Box>
        <Box>
          <Button
            component={RouterLink}
            to={`/cdn/${vod.id}`}
            color="primary"
            disabled={Date.now() - new Date(vod.createdAt).getTime() >= 14 * 24 * 60 * 60 * 1000 || !isCdnAvailable}
            startIcon={<OndemandVideo />}
            size="large"
            fullWidth
            sx={{ justifyContent: "flex-start" }}
          >
            CDN (VOD)
          </Button>
        </Box>
        <Box>
          <Button component={RouterLink} to={`/games/${vod.id}`} color="primary" disabled={vod.games.length === 0} startIcon={<YouTubeIcon />} size="large" fullWidth sx={{ justifyContent: "flex-start" }}>
            Youtube (Only Games)
          </Button>
        </Box>
      </Box>
    </Menu>
  );
}
