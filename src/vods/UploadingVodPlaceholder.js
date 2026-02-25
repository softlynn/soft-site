import { Box, Grid, LinearProgress, Typography } from "@mui/material";
import dayjs from "dayjs";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";

const DEFAULT_CARD_WIDTH = "20.75rem";

dayjs.extend(localizedFormat);

const clampPercent = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
};

const formatEta = (uploadedBytes, totalBytes, updatedAtMs, createdAtMs) => {
  const uploaded = Number(uploadedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(uploaded) || !Number.isFinite(total) || total <= 0 || uploaded <= 0 || uploaded >= total) return null;

  const nowMs = Date.now();
  const startedAtMs = Number.isFinite(Number(createdAtMs)) ? Number(createdAtMs) : nowMs;
  const latestAtMs = Number.isFinite(Number(updatedAtMs)) ? Number(updatedAtMs) : nowMs;
  const elapsedMs = Math.max(1000, latestAtMs - startedAtMs);
  const bps = (uploaded * 1000) / elapsedMs;
  if (!Number.isFinite(bps) || bps <= 1) return null;

  const remainingSeconds = Math.ceil((total - uploaded) / bps);
  if (remainingSeconds < 60) return `${remainingSeconds}s ETA`;
  if (remainingSeconds < 3600) return `${Math.ceil(remainingSeconds / 60)}m ETA`;
  const hours = Math.floor(remainingSeconds / 3600);
  const mins = Math.ceil((remainingSeconds % 3600) / 60);
  return `${hours}h ${mins}m ETA`;
};

export default function UploadingVodPlaceholder({ upload, sizes, cardWidth }) {
  const resolvedCardWidth = cardWidth || DEFAULT_CARD_WIDTH;
  const percent = clampPercent(upload?.percent);
  const isPreparing = upload?.state === "preparing";
  const isUploading = upload?.state === "uploading";
  const isFinalizing = upload?.state === "finalizing";
  const statusLabel = isPreparing ? "Preparing" : isUploading ? "Uploading" : isFinalizing ? "Finalizing" : "Uploading";

  const displayTitle = upload?.title || upload?.recordingName || "New VOD upload";
  const helperLine = upload?.message || (isPreparing ? "Preparing track 1 upload copy" : isFinalizing ? "Finalizing archive metadata" : "Uploading to YouTube");
  const etaText = formatEta(upload?.uploadedBytes, upload?.totalBytes, upload?.updatedAtMs, upload?.createdAtMs);

  return (
    <Grid size={sizes || { xs: 12 }} sx={{ maxWidth: resolvedCardWidth, flexBasis: resolvedCardWidth }}>
      <Box
        className="soft-glass soft-surface-float"
        sx={{
          borderRadius: "22px",
          p: 0.95,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          border: "1px dashed rgba(212,107,140,0.35)",
        }}
      >
        <Box
          className="soft-vod-card__media"
          sx={{
            overflow: "hidden",
            height: 0,
            paddingTop: "56.25%",
            position: "relative",
            borderRadius: "16px",
            background:
              "radial-gradient(circle at 22% 18%, rgba(212,107,140,0.25), transparent 45%), radial-gradient(circle at 75% 30%, rgba(91,130,190,0.22), transparent 48%), linear-gradient(180deg, rgba(255,255,255,0.25), rgba(255,255,255,0.06))",
            border: "1px solid var(--soft-border)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
          }}
        >
          <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", p: 1.1 }}>
            <Box sx={{ textAlign: "center" }}>
              <CloudUploadRoundedIcon sx={{ fontSize: 34, color: "primary.main", opacity: 0.9 }} />
              <Typography variant="body2" sx={{ mt: 0.5, color: "text.primary", fontWeight: 700 }}>
                {statusLabel} VOD
              </Typography>
              {percent != null && (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {percent.toFixed(1)}%
                </Typography>
              )}
            </Box>
          </Box>

          <Box sx={{ position: "absolute", bottom: 10, left: 10, right: 10, display: "flex", justifyContent: "space-between", gap: 1 }}>
            <Typography
              variant="caption"
              className="soft-vod-card__metachip"
              sx={{
                px: 0.85,
                py: 0.35,
                borderRadius: "10px",
                backgroundColor: "rgba(18,29,50,.68)",
                color: "rgba(255,255,255,0.95)",
                backdropFilter: "blur(8px)",
              }}
            >
              {upload?.streamDate ? dayjs(upload.streamDate).format("LL") : "Uploading now"}
            </Typography>
            <Typography
              variant="caption"
              className="soft-vod-card__metachip"
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
              {etaText || "Working..."}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ px: 0.35, pt: 0.1 }}>
          <Typography variant="body2" sx={{ color: "primary.main", fontWeight: 700, lineHeight: 1.28 }} noWrap>
            {displayTitle}
            {upload?.partNumber ? ` (Part ${upload.partNumber})` : ""}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 0.25 }} noWrap title={helperLine}>
            {helperLine}
          </Typography>
          <Box sx={{ mt: 0.75 }}>
            <LinearProgress
              variant={percent == null || isPreparing ? "indeterminate" : "determinate"}
              value={percent == null ? 0 : percent}
              sx={{
                height: 7,
                borderRadius: 999,
                backgroundColor: "rgba(19,33,56,0.08)",
                border: "1px solid rgba(19,33,56,0.08)",
                '& .MuiLinearProgress-bar': {
                  borderRadius: 999,
                  background: "linear-gradient(90deg, #D46B8C 0%, #6FA0E6 100%)",
                },
              }}
            />
          </Box>
        </Box>
      </Box>
    </Grid>
  );
}
