import LoadingLogo from "../assets/loading.gif";
import { Box, CircularProgress } from "@mui/material";

export default function Loading() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", width: "100%", p: 2 }}>
      <Box className="soft-glass soft-shimmer" sx={{ px: 3, py: 2.5, borderRadius: "22px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minWidth: 220 }}>
        <img alt="" src={LoadingLogo} style={{ height: "auto", maxWidth: "96px", filter: "drop-shadow(0 8px 18px rgba(19,33,56,.12))" }} />
        <CircularProgress sx={{ marginTop: "1rem", color: "#D46B8C" }} size="1.85rem" />
      </Box>
    </Box>
  );
}
