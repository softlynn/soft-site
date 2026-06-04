import { Box, CircularProgress } from "@mui/material";

export default function Loading() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", width: "100%", p: 2 }}>
      <CircularProgress sx={{ color: "var(--soft-muted)" }} size="1.55rem" thickness={3.2} />
    </Box>
  );
}
