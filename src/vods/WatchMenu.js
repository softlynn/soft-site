import YouTubeIcon from "@mui/icons-material/YouTube";
import { Menu, Button, Box } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";

export default function WatchMenu(props) {
  const { vod, anchorEl, setAnchorEl } = props;

  return (
    <Menu anchorEl={anchorEl} keepMounted open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
      <Box sx={{ pl: 1 }}>
        <Box>
          <Button component={RouterLink} to={`/youtube/${vod.id}`} color="primary" disabled={vod.youtube.length === 0} startIcon={<YouTubeIcon />} size="large" fullWidth sx={{ justifyContent: "flex-start" }}>
            Youtube (Vod)
          </Button>
        </Box>
      </Box>
    </Menu>
  );
}
