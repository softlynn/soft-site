import { useState } from "react";
import { Box, IconButton, Menu, MenuItem, Typography, Tooltip } from "@mui/material";
import CustomLink from "../utils/CustomLink";
import humanize from "humanize-duration";
import { toHMS } from "../utils/helpers";
import ChapterArtwork from "./ChapterArtwork";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";

export default function Chapters(props) {
  const { vod } = props;
  const [anchorEl, setAnchorEl] = useState(null);
  const DEFAULT_VOD = vod.youtube.length > 0 ? `/youtube/${vod.id}` : `#`;

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleClick = (event) => {
    setAnchorEl(event.currentTarget);
  };

  return (
    <Box>
      <Tooltip title="Jump to a chapter" disableInteractive>
        <IconButton
          className="soft-card-chapter-button"
          aria-label="Jump to a chapter"
          aria-haspopup="menu"
          aria-expanded={Boolean(anchorEl)}
          onClick={handleClick}
          sx={{
            borderRadius: "12px",
            p: 0.35,
            background: "rgba(255,255,255,0.4)",
            border: "1px solid rgba(255,255,255,0.5)",
            "&:hover": { background: "rgba(255,255,255,0.7)" },
          }}
        >
          <ChapterArtwork image={vod.chapters[0].image} width={32} height={42} borderRadius="8px" />
          <KeyboardArrowDownRoundedIcon className="soft-card-chapter-chevron" />
        </IconButton>
      </Tooltip>
      <Menu className="soft-card-chapter-menu" anchorEl={anchorEl} keepMounted open={Boolean(anchorEl)} onClose={handleClose}>
        {vod.chapters.map((data, _) => {
          return (
              <MenuItem component={CustomLink} key={data.gameId + data.start} href={`${DEFAULT_VOD}?t=${toHMS(data?.start || 1)}`}>
                <Box sx={{ display: "flex" }}>
                  <Box sx={{ mr: 1 }}>
                    <ChapterArtwork image={data.image} />
                  </Box>
                  <Box sx={{ display: "flex", flexDirection: "column" }}>
                    <Typography color="inherit" variant="body2">{`${data.name ?? "Chapter 1"}`}</Typography>
                    <Typography variant="caption">{`${humanize(data.end * 1000, { largest: 2 })}`}</Typography>
                  </Box>
                </Box>
              </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
}
