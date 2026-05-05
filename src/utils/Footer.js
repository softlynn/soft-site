import { Box, Stack, SvgIcon, Typography } from "@mui/material";
import GitInfo from "react-git-info/macro";
import CustomLink from "./CustomLink";
import { BRAND_NAME, GITHUB_REPO } from "../config/site";
import { useSiteDesign } from "../design/DesignContext";

const gitInfo = GitInfo();
const COPYRIGHT_YEAR = 2026;

function TypeGpuMark(props) {
  return (
    <SvgIcon viewBox="0 0 24 24" fontSize="inherit" {...props}>
      <path
        d="M4 6.5c0-1.38 1.12-2.5 2.5-2.5h11C18.88 4 20 5.12 20 6.5v11c0 1.38-1.12 2.5-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"
        fill="currentColor"
        opacity="0.14"
      />
      <path d="M7 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16.5" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 9.5v-2M14.3 10.6l-1.4-1.4M18.7 10.6l1.4-1.4M19 12h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </SvgIcon>
  );
}

export default function Footer() {
  const { design } = useSiteDesign();
  const settings = design.settings || {};
  const brandLabel = String(BRAND_NAME || "Softu").toLowerCase();
  const footerText = settings.footerText || `${brandLabel} © ${COPYRIGHT_YEAR}`;
  const footerLinks = [
    { label: settings.footerLink1Label, href: settings.footerLink1Href },
    { label: settings.footerLink2Label, href: settings.footerLink2Href, icon: <TypeGpuMark sx={{ fontSize: 16, color: "#395473" }} /> },
    { label: settings.footerLink3Label, href: settings.footerLink3Href },
  ].filter((item) => item.label && item.href);

  if (settings.footerEnabled === false) return null;

  return (
    <Box
      component="footer"
      className="soft-glass soft-surface-float soft-panel-ambient soft-footer-shell"
      sx={{
        mt: 3,
        mx: { xs: 1.5, sm: 2.5 },
        mb: 2,
        px: { xs: 1.55, sm: 2.4 },
        py: { xs: 1.35, sm: 1.45 },
        borderRadius: `${Math.max(0, Number(settings.footerRadius) || 20)}px`,
        ...(settings.footerSurface === "solid"
          ? {
              background: "var(--soft-surface-strong)",
              backdropFilter: "none",
            }
          : settings.footerSurface === "transparent"
            ? {
                background: "transparent",
                borderColor: "transparent",
                boxShadow: "none",
                backdropFilter: "none",
              }
            : {}),
      }}
    >
      <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 0.9, md: 2 }} alignItems={{ xs: "flex-start", md: "center" }} justifyContent="space-between">
        <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.45, sm: 1.5 }} alignItems={{ xs: "flex-start", sm: "center" }} sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700, letterSpacing: "0.02em" }}>
            {footerText}
          </Typography>
          {footerLinks.map((item, index) => (
            <CustomLink key={`${item.href}-${index}`} href={item.href} rel="noopener noreferrer" target="_blank">
              <Stack direction="row" spacing={0.5} alignItems="center">
                {item.icon}
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: index === 2 ? 500 : 600, opacity: index === 2 ? 0.72 : 1 }}>
                  {item.label}
                </Typography>
              </Stack>
            </CustomLink>
          ))}
        </Stack>

        {settings.footerShowBuild !== false && GITHUB_REPO && (
          <CustomLink href={`${GITHUB_REPO}/commit/${gitInfo.commit.shortHash}`} rel="noopener noreferrer" target="_blank">
            <Typography variant="caption" sx={{ color: "text.secondary", opacity: 0.44, fontSize: "0.68rem", letterSpacing: "0.04em" }}>
              {`build ${gitInfo.commit.shortHash}`}
            </Typography>
          </CustomLink>
        )}
      </Stack>
    </Box>
  );
}
