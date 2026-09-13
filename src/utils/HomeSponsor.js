import { Box, Typography } from "@mui/material";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";

const SPONSOR_URL = "https://advanced.gg/?ref=soft";
const ADVANCED_LOGO_URL = "https://advanced.gg/cdn/shop/files/ADV-Logo-Horizontal_2560x.png?v=1762909429";

export default function HomeSponsor() {
  return (
    <Box
      className="soft-home-sponsor"
      sx={{
        width: "100%",
        maxWidth: 460,
        mx: "auto",
        px: { xs: 1.5, sm: 2 },
        pt: { xs: 1.4, md: 0.9 },
        textAlign: "center",
      }}
    >
      <Typography
        className="soft-home-sponsor__offer"
        sx={{
          mb: 0.8,
          color: "text.primary",
          fontSize: { xs: "0.82rem", sm: "0.9rem" },
          fontWeight: 650,
          letterSpacing: "-0.01em",
        }}
      >
        Use code{" "}
        <Box
          component="span"
          sx={{
            color: "#ffad72",
            fontWeight: 800,
            "[data-soft-theme=\"light\"] &": { color: "#b45719" },
          }}
        >
          SOFT
        </Box>{" "}
        for 10% off!
      </Typography>

      <Box
        component="a"
        className="soft-home-sponsor__link"
        href={SPONSOR_URL}
        target="_blank"
        rel="noopener noreferrer sponsored"
        aria-label="Shop ADVANCED with code SOFT"
        sx={{
          minHeight: { xs: 62, sm: 68 },
          display: "flex",
          alignItems: "center",
          gap: { xs: 1.15, sm: 1.5 },
          p: 0.75,
          pr: { xs: 1.1, sm: 1.4 },
          borderRadius: "13px",
          color: "#f5f5f7",
          background: "#181922",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "0 10px 28px rgba(0,0,0,0.18)",
          textAlign: "left",
          transition: "transform 160ms ease, border-color 160ms ease, background-color 160ms ease",
          "&:hover": {
            transform: "translateY(-1px)",
            borderColor: "rgba(255,173,114,0.34)",
            background: "#1d1e28",
          },
          "&:focus-visible": {
            outline: "2px solid #ffad72",
            outlineOffset: 3,
          },
          "[data-soft-theme=\"light\"] &": {
            color: "#2b2119",
            background: "rgba(255, 250, 241, 0.92)",
            borderColor: "rgba(102, 66, 35, 0.18)",
            boxShadow: "0 10px 26px rgba(111, 80, 42, 0.12)",
            "&:hover": {
              background: "#fffdf8",
              borderColor: "rgba(181, 87, 30, 0.34)",
            },
            "&:focus-visible": {
              outlineColor: "#b85a21",
            },
          },
        }}
      >
        <Box
          sx={{
            width: { xs: 66, sm: 74 },
            alignSelf: "stretch",
            flex: "0 0 auto",
            display: "grid",
            placeItems: "center",
            px: 0.8,
            borderRadius: "9px",
            background: "#0e0f15",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Box
            component="img"
            src={ADVANCED_LOGO_URL}
            alt="ADVANCED"
            loading="lazy"
            sx={{ display: "block", width: "100%", height: "auto", maxHeight: 34, objectFit: "contain" }}
          />
        </Box>

        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ color: "inherit", fontSize: { xs: "0.9rem", sm: "0.98rem" }, fontWeight: 750, lineHeight: 1.15 }}>
            ADVANCED
          </Typography>
          <Typography
            noWrap
            sx={{
              mt: 0.35,
              color: "inherit",
              opacity: 0.58,
              fontFamily: "Roboto, Arial, sans-serif",
              fontSize: { xs: "0.72rem", sm: "0.78rem" },
              lineHeight: 1.2,
            }}
          >
            advanced.gg/?ref=soft
          </Typography>
        </Box>

        <OpenInNewRoundedIcon sx={{ flex: "0 0 auto", color: "inherit", opacity: 0.44, fontSize: 18 }} />
      </Box>
    </Box>
  );
}
