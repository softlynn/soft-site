import { Box, Button, Typography } from "@mui/material";
import CustomLink from "./CustomLink";
import { BRAND_NAME } from "../config/site";
import { useSiteDesign } from "../design/DesignContext";

export default function NotFound() {
  const { design } = useSiteDesign();
  const settings = design.settings || {};
  const imageUrl = String(settings.notFoundImageUrl || "").trim();
  const title = settings.notFoundTitle || "404";
  const body = settings.notFoundBody || "this page is not here";
  const buttonLabel = settings.notFoundButtonLabel || "return home";

  document.title = `Not Found - ${BRAND_NAME}`;

  return (
    <Box
      sx={{
        minHeight: "100%",
        width: "100%",
        display: "grid",
        placeItems: "center",
        px: 2,
        py: 5,
        background: "var(--soft-bg)",
      }}
    >
      <Box sx={{ textAlign: "center", maxWidth: 560 }}>
        {imageUrl && (
          <Box
            component="img"
            src={imageUrl}
            alt=""
            sx={{
              display: "block",
              width: "min(220px, 58vw)",
              height: "auto",
              mx: "auto",
              mb: 2,
              borderRadius: "18px",
            }}
          />
        )}
        <Typography
          variant="h1"
          sx={{
            color: "var(--soft-text)",
            fontFamily: "var(--soft-brand-font)",
            fontSize: { xs: "3rem", sm: "4rem" },
            lineHeight: 1,
            letterSpacing: 0,
            textTransform: "lowercase",
          }}
        >
          {title}
        </Typography>
        <Typography variant="body1" sx={{ color: "var(--soft-muted)", mt: 1, mb: 2 }}>
          {body}
        </Typography>
        <CustomLink href="/">
          <Button variant="outlined" sx={{ borderRadius: "999px", px: 2 }}>
            {buttonLabel}
          </Button>
        </CustomLink>
      </Box>
    </Box>
  );
}
