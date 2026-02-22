import React, { useMemo, useRef, useState } from "react";
import { AppBar, Toolbar, Typography, useMediaQuery, Box, Divider, Button, Stack, Tooltip, IconButton } from "@mui/material";
import { useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "@mui/material/styles";
import Logo from "../assets/logo.png";
import CustomLink from "../utils/CustomLink";
import TwitterIcon from "@mui/icons-material/Twitter";
import SvgIcon from "@mui/material/SvgIcon";
import RedditIcon from "@mui/icons-material/Reddit";
import YouTubeIcon from "@mui/icons-material/YouTube";
import Drawer from "./Drawer";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import ReportIcon from "@mui/icons-material/Report";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import { GITHUB_ISSUES_URL, SITE_TITLE, SOCIAL_LINKS } from "../config/site";
import { setPendingAdminPassword } from "../api/adminApi";

const ADMIN_TAP_WINDOW_MS = 3500;
const HOME_NAV_DELAY_MS = 900;
const titleTapStateStore = { count: 0, lastTapMs: 0, active: false, homeNavTimer: null };

const socials = [
  { key: "reddit", path: SOCIAL_LINKS.reddit, icon: <RedditIcon fontSize="small" />, label: "Reddit" },
  { key: "youtube", path: SOCIAL_LINKS.youtube, icon: <YouTubeIcon fontSize="small" />, label: "YouTube" },
  {
    key: "discord",
    path: SOCIAL_LINKS.discord,
    icon: (
      <SvgIcon viewBox="0 0 71 55" fontSize="small">
        <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1066 30.1693C30.1066 34.1136 27.28 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z" />
      </SvgIcon>
    ),
    label: "Discord",
  },
  { key: "twitter", path: SOCIAL_LINKS.twitter, icon: <TwitterIcon fontSize="small" />, label: "X" },
  {
    key: "twitch",
    path: SOCIAL_LINKS.twitch,
    icon: (
      <SvgIcon fontSize="small">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
      </SvgIcon>
    ),
    label: "Twitch",
  },
].filter(({ path }) => Boolean(path));

const navChipSx = {
  borderRadius: "999px",
  border: "1px solid var(--soft-border)",
  background: "var(--soft-surface)",
  color: "text.primary",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
  transition: "transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease",
  "&:hover": {
    transform: "translateY(-1px)",
    boxShadow: "0 10px 20px rgba(19,33,56,0.09), inset 0 1px 0 rgba(255,255,255,0.18)",
    background: "var(--soft-surface-strong)",
  },
};

export default function Navbar() {
  const isMobile = useMediaQuery("(max-width: 900px)");
  const theme = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const titleTapState = useRef(titleTapStateStore);
  const [logoBurstSeed, setLogoBurstSeed] = useState(0);

  const mainLinks = useMemo(
    () =>
      [
        { title: "Home", path: "/", icon: <HomeRoundedIcon sx={{ fontSize: 16 }} /> },
        { title: "VODs", path: "/vods", icon: <OndemandVideoIcon sx={{ fontSize: 16 }} /> },
      ].map((item) => ({ ...item, active: location.pathname === item.path })),
    [location.pathname]
  );

  const handleSiteTitleClick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const tapState = titleTapState.current;
    if (tapState.active) return;

    if (tapState.homeNavTimer) {
      clearTimeout(tapState.homeNavTimer);
      tapState.homeNavTimer = null;
    }

    const now = Date.now();
    if (!tapState.lastTapMs || now - tapState.lastTapMs > ADMIN_TAP_WINDOW_MS) {
      tapState.count = 0;
    }
    tapState.lastTapMs = now;
    tapState.count += 1;

    if (tapState.count < 3) {
      const hash = String(window.location.hash || "");
      const isAlreadyHome = hash === "" || hash === "#" || hash === "#/";
      if (isAlreadyHome) return;
      tapState.homeNavTimer = window.setTimeout(() => {
        tapState.count = 0;
        tapState.lastTapMs = 0;
        tapState.homeNavTimer = null;
        navigate("/");
      }, HOME_NAV_DELAY_MS);
      return;
    }

    tapState.count = 0;
    tapState.lastTapMs = 0;
    tapState.homeNavTimer = null;

    tapState.active = true;
    try {
      const password = window.prompt("Enter admin password");
      if (password == null) {
        window.alert("Admin login canceled.");
        return;
      }
      const normalizedPassword = String(password).trim();
      if (!normalizedPassword) {
        window.alert("Admin login failed: Admin password cannot be empty.");
        return;
      }
      setPendingAdminPassword(normalizedPassword);
      const adminUrl = `${window.location.pathname}${window.location.search}#/admin`;
      window.location.assign(adminUrl);
    } catch (error) {
      window.alert(`Admin login failed: ${error.message}`);
    } finally {
      tapState.active = false;
    }
  };

  const handleLogoClick = () => {
    setLogoBurstSeed((seed) => seed + 1);
  };

  return (
    <Box sx={{ px: { xs: 1, sm: 1.5 }, pt: { xs: 1, sm: 1.25 }, pb: 0.5 }}>
      <AppBar position="static" elevation={0} sx={{ borderRadius: "20px" }}>
        <Toolbar sx={{ minHeight: { xs: 64, md: 72 }, px: { xs: 1, md: 1.5 }, gap: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            {isMobile && <Drawer socials={socials} />}

            <CustomLink color="inherit" href="/" onClick={handleLogoClick} sx={{ mr: 1.25 }}>
              <Box
                className="soft-logo-shell"
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: "14px",
                  background: theme.palette.mode === "dark" ? "rgba(23,31,47,0.76)" : "var(--soft-surface)",
                  border: "1px solid var(--soft-border)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,.14), 0 6px 14px rgba(19,33,56,.08)",
                  display: "grid",
                  placeItems: "center",
                  position: "relative",
                }}
              >
                <Box
                  sx={{
                    width: 38,
                    height: 38,
                    borderRadius: "12px",
                    background: "rgba(255,255,255,0.96)",
                    display: "grid",
                    placeItems: "center",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,.95)",
                  }}
                >
                  <img alt="" style={{ maxWidth: "34px", height: "auto" }} src={Logo} />
                </Box>
                {logoBurstSeed > 0 &&
                  Array.from({ length: 8 }, (_, i) => {
                    const angle = (Math.PI * 2 * i) / 8;
                    const radius = 12 + (i % 2) * 6;
                    return (
                      <Box
                        key={`${logoBurstSeed}-${i}`}
                        className="soft-logo-bubble"
                        sx={{
                          "--dx": `${Math.cos(angle) * radius}px`,
                          "--dy": `${Math.sin(angle) * radius}px`,
                          "--delay": `${i * 12}ms`,
                          "--size": `${i % 3 === 0 ? 7 : 5}px`,
                        }}
                      />
                    );
                  })}
              </Box>
            </CustomLink>

            <Box sx={{ minWidth: 0 }}>
              <Typography
                color="primary"
                variant="h6"
                component="button"
                onClick={handleSiteTitleClick}
                sx={{
                  border: 0,
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  p: 0,
                  m: 0,
                  font: "inherit",
                  textAlign: "left",
                  lineHeight: 1.1,
                  "&:hover": { opacity: 0.84 },
                }}
              >
                {String(SITE_TITLE || "softu").toLowerCase()}
              </Typography>
              {!isMobile && (
                <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 0.1, letterSpacing: "0.03em" }}>
                  vod archives with chat replay
                </Typography>
              )}
            </Box>

            {!isMobile && socials.length > 0 && (
              <>
                <Divider orientation="vertical" flexItem variant="middle" sx={{ mx: 1.5, borderColor: "rgba(19,33,56,0.08)" }} />
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                  {socials.map(({ path, icon, label }) => (
                    <CustomLink key={path} href={path} rel="noopener noreferrer" target="_blank" aria-label={label}>
                      <Box
                        sx={{
                          ...navChipSx,
                          width: 34,
                          height: 34,
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        {icon}
                      </Box>
                    </CustomLink>
                  ))}
                </Stack>
              </>
            )}
          </Box>

          {!isMobile && (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
              {mainLinks.map((item) => (
                <CustomLink key={item.path} href={item.path}>
                  <Button
                    variant={item.active ? "contained" : "outlined"}
                    color={item.active ? "secondary" : "primary"}
                    startIcon={item.icon}
                    sx={{
                      borderRadius: "999px",
                      px: 1.35,
                      minWidth: 96,
                      height: 40,
                      fontWeight: 800,
                      letterSpacing: "0.01em",
                      borderColor: item.active ? "rgba(212,107,140,0.28)" : "var(--soft-border)",
                      background: item.active ? "linear-gradient(180deg, rgba(212,107,140,0.20), rgba(212,107,140,0.10))" : "var(--soft-surface)",
                      color: item.active ? "secondary.main" : "text.primary",
                      boxShadow: item.active
                        ? "0 10px 22px rgba(212,107,140,0.12), inset 0 1px 0 rgba(255,255,255,0.18)"
                        : "inset 0 1px 0 rgba(255,255,255,0.14)",
                      "& .MuiButton-startIcon svg": { fontSize: 18 },
                    }}
                  >
                    {item.title}
                  </Button>
                </CustomLink>
              ))}

              {GITHUB_ISSUES_URL && (
                <Tooltip title="Issues">
                  <CustomLink href={GITHUB_ISSUES_URL} rel="noopener noreferrer" target="_blank" aria-label="Issues">
                    <IconButton
                      size="small"
                      sx={{
                        width: 36,
                        height: 36,
                        borderRadius: "12px",
                        border: "1px solid var(--soft-border)",
                        background: "var(--soft-surface)",
                        opacity: 0.78,
                      }}
                    >
                      <ReportIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </CustomLink>
                </Tooltip>
              )}
            </Stack>
          )}
        </Toolbar>
      </AppBar>
    </Box>
  );
}
