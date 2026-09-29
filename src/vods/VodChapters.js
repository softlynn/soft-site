import { useState } from "react";
import { Box, Tooltip, IconButton, Menu, MenuItem, SvgIcon, Typography } from "@mui/material";
import humanize from "humanize-duration";
import { resolvePlaybackPosition } from "./replayUtils.mjs";
import ChapterArtwork from "./ChapterArtwork";

export default function Chapters(props) {
  const { chapters, chapter, setPart, youtube, setChapter, setTimestamp } = props;
  const [anchorEl, setAnchorEl] = useState(null);

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleClick = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleChapterClick = (data) => {
    if (youtube) {
      setPart(resolvePlaybackPosition(youtube, 1, data?.start ?? 0));
    } else {
      setTimestamp(data?.start ?? 0);
    }
    setChapter(data);
    setAnchorEl(null);
  };

  return (
    <Box className="soft-viewer-chapters" sx={{ display: "flex", alignItems: "center" }}>
      <Tooltip title="Choose chapter">
        <IconButton
          className="soft-viewer-chapter-trigger"
          aria-label="Choose chapter"
          aria-haspopup="menu"
          aria-expanded={Boolean(anchorEl)}
          onClick={handleClick}
          sx={{ width: 44, height: 44, p: 0 }}
        >
          <SvgIcon aria-hidden="true" sx={{ fontSize: 20 }}>
            <path d="M3 10h10v2H3zm0-4h10v2H3zm0 8h6v2H3zm12-4v8l7-4z" />
          </SvgIcon>
        </IconButton>
      </Tooltip>
      <Menu className="soft-viewer-chapter-menu" anchorEl={anchorEl} keepMounted open={Boolean(anchorEl)} onClose={handleClose} slotProps={{ list: { "aria-label": "Chapters" } }} sx={{ maxWidth: "280px", maxHeight: "400px" }}>
        {chapters.map((data, _) => {
          return (
            <MenuItem onClick={() => handleChapterClick(data)} key={data.gameId + data.start} selected={data.start === chapter.start}>
              <Box sx={{ display: "flex" }}>
                <Box sx={{ mr: 1 }}>
                  <ChapterArtwork image={data.image} />
                </Box>
                <Box sx={{ display: "flex", flexDirection: "column" }}>
                  <Typography color="inherit" variant="body2" noWrap>{`${data.name ?? "Chapter 1"}`}</Typography>
                  <Typography variant="caption" color="textSecondary" noWrap>{`${humanize(data.end * 1000, { largest: 2 })}`}</Typography>
                </Box>
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
}
