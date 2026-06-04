import { Box, Typography } from "@mui/material";
import { setPendingAdminPassword } from "../api/adminApi";
import { BRAND_NAME } from "../config/site";
import { useSiteDesign } from "../design/DesignContext";

const COPYRIGHT_YEAR = 2026;

export default function Footer() {
  const { design } = useSiteDesign();
  const settings = design.settings || {};
  const brandLabel = String(BRAND_NAME || "soft").toLowerCase();
  const baseText = settings.footerText || `${brandLabel} © ${COPYRIGHT_YEAR}`;

  if (settings.footerEnabled === false) return null;

  const handleAdminClick = (event) => {
    event.preventDefault();
    const password = window.prompt("Enter admin password");
    if (password == null) return;
    const normalizedPassword = String(password).trim();
    if (!normalizedPassword) {
      window.alert("Admin password cannot be empty.");
      return;
    }
    setPendingAdminPassword(normalizedPassword);
    window.location.assign("/admin");
  };

  return (
    <Box
      component="footer"
      sx={{
        flex: "0 0 auto",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 0.65,
        px: 2,
        pt: 2,
        pb: { xs: 1.25, sm: 1.45 },
        color: "var(--soft-muted)",
        textAlign: "center",
      }}
    >
      <Typography
        component="button"
        type="button"
        onClick={handleAdminClick}
        variant="caption"
        sx={{
          border: 0,
          p: 0,
          m: 0,
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          fontFamily: "var(--soft-body-font)",
          fontWeight: 600,
          letterSpacing: 0,
          transition: "color 140ms ease, opacity 140ms ease",
          "&:hover": {
            color: "var(--soft-text)",
            opacity: 0.82,
          },
        }}
      >
        {baseText}
      </Typography>
    </Box>
  );
}
