import { Box, Typography, Grid, Button } from "@mui/material";
import Thumbnail from "../assets/default_thumbnail.png";
import Chapters from "./ChaptersMenu";
import CustomWidthTooltip from "../utils/CustomToolTip";
import { useMemo } from "react";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import { useNavigate } from "react-router-dom";

dayjs.extend(localizedFormat);

const DEFAULT_CARD_WIDTH = "18.75rem";

export default function Vod(props) {
  const { vod, gridSize, sizes, sheen = false } = props;
  const navigate = useNavigate();

  const thumbnail = useMemo(() => {
    if (vod.youtube?.length > 0) return vod.youtube[0].thumbnail_url;
    if (vod.games?.length > 0) return vod.games[0].thumbnail_url;
    return vod.thumbnail_url || Thumbnail;
  }, [vod]);

  const openVod = () => {
    if (vod.youtube?.length === 0) return;
    navigate(`/youtube/${vod.id}`);
  };

  return (
    <Grid size={sizes || { xs: gridSize }} sx={{ maxWidth: DEFAULT_CARD_WIDTH, flexBasis: DEFAULT_CARD_WIDTH }}>
      <Box
        className={`soft-glass soft-surface-float${sheen ? " soft-shimmer" : ""}`}
        sx={{
          borderRadius: "22px",
          p: 0.85,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 0.95,
        }}
      >
        <Box
          onClick={openVod}
          sx={{
            overflow: "hidden",
            height: 0,
            paddingTop: "56.25%",
            position: "relative",
            borderRadius: "16px",
            cursor: vod.youtube?.length ? "pointer" : "default",
            background: "var(--soft-surface)",
            border: "1px solid var(--soft-border)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
            "& img": {
              transition: "transform 360ms cubic-bezier(.2,.8,.2,1), filter 260ms ease",
            },
            "&:hover img": {
              transform: "scale(1.055)",
              filter: "saturate(1.06) contrast(1.02)",
            },
          }}
        >
          <img className="thumbnail" alt="" src={thumbnail} />

          <Box
            sx={{
              pointerEvents: "none",
              position: "absolute",
              inset: 0,
              background: "linear-gradient(180deg, rgba(19,33,56,0.02) 15%, rgba(19,33,56,0.55) 100%)",
              borderRadius: "inherit",
            }}
          />

          <Box sx={{ position: "absolute", top: 10, left: 10 }}>
            <Box
              sx={{
                px: 1,
                py: 0.45,
                borderRadius: "999px",
                background: "var(--soft-surface-strong)",
                border: "1px solid var(--soft-border)",
                boxShadow: "0 8px 16px rgba(19,33,56,0.10)",
                display: "flex",
                alignItems: "center",
                gap: 0.5,
              }}
            >
              <PlayArrowRoundedIcon sx={{ fontSize: 16, color: "#7f2946" }} />
              <Typography variant="caption" sx={{ color: "text.primary", fontWeight: 700 }}>
                Watch
              </Typography>
            </Box>
          </Box>

          <Box sx={{ position: "absolute", bottom: 10, left: 10, right: 10, display: "flex", justifyContent: "space-between", gap: 1 }}>
            <Typography
              variant="caption"
              sx={{
                px: 0.85,
                py: 0.35,
                borderRadius: "10px",
                backgroundColor: "rgba(18,29,50,.68)",
                color: "rgba(255,255,255,0.95)",
                backdropFilter: "blur(8px)",
              }}
            >
              {dayjs(vod.createdAt).format("LL")}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                px: 0.85,
                py: 0.35,
                borderRadius: "10px",
                backgroundColor: "rgba(18,29,50,.68)",
                color: "rgba(255,255,255,0.95)",
                display: "flex",
                alignItems: "center",
                gap: 0.35,
                backdropFilter: "blur(8px)",
              }}
            >
              <AccessTimeRoundedIcon sx={{ fontSize: 13 }} />
              {vod.duration}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
          {vod.chapters && vod.chapters.length > 0 && <Chapters vod={vod} />}

          <Box sx={{ minWidth: 0, width: "100%" }}>
            <CustomWidthTooltip title={vod.title} placement="top">
              <Button
                onClick={openVod}
                sx={{
                  width: "100%",
                  justifyContent: "flex-start",
                  textAlign: "left",
                  px: 0.5,
                  py: 0.35,
                  borderRadius: "12px",
                  "&:hover": {
                    background: "rgba(255,255,255,0.55)",
                  },
                }}
                size="small"
                disabled={vod.youtube?.length === 0}
              >
                <Typography
                  fontWeight={700}
                  variant="body2"
                  color="primary"
                  noWrap
                  sx={{ width: "100%", textAlign: "left", lineHeight: 1.25 }}
                >
                  {vod.title}
                </Typography>
              </Button>
            </CustomWidthTooltip>
          </Box>
        </Box>
      </Box>
    </Grid>
  );
}
