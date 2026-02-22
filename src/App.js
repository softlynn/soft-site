import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { alpha, createTheme, ThemeProvider, responsiveFontSizes } from "@mui/material/styles";
import { CssBaseline, styled } from "@mui/material";
import Loading from "./utils/Loading";
import { LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import LiquidBackdrop from "./utils/LiquidBackdrop";
import ThemeModeToggle from "./utils/ThemeModeToggle";
import { ThemeModeContext } from "./utils/ThemeModeContext";

const Vods = lazy(() => import("./vods/Vods"));
const YoutubeVod = lazy(() => import("./vods/YoutubeVod"));
const CustomVod = lazy(() => import("./vods/CustomVod"));
const Games = lazy(() => import("./games/Games"));
const Navbar = lazy(() => import("./navbar/Navbar"));
const NotFound = lazy(() => import("./utils/NotFound"));
const AdminPage = lazy(() => import("./admin/AdminPage"));

const THEME_STORAGE_KEY = "softu-theme-mode";
const isViewerPath = (path) =>
  String(path || "").startsWith("/youtube/") || String(path || "").startsWith("/cdn/") || String(path || "").startsWith("/games/");

const getHashPath = () => {
  if (typeof window === "undefined") return "/";
  const rawHash = String(window.location.hash || "");
  if (!rawHash || rawHash === "#") return "/";
  const hashWithoutPrefix = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const pathOnly = hashWithoutPrefix.split("?")[0];
  if (!pathOnly || pathOnly === "/") return "/";
  return pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
};

const getInitialThemeMode = () => {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return "light";
};

const buildTheme = (mode) => {
  const isDark = mode === "dark";

  let theme = createTheme({
    palette: {
      mode,
      background: {
        default: isDark ? "#0F172A" : "#E2E9F3",
        paper: isDark ? "rgba(20,28,44,0.72)" : "rgba(255,255,255,0.72)",
      },
      primary: {
        main: isDark ? "#E7EFFA" : "#132138",
      },
      secondary: {
        main: "#D46B8C",
      },
      text: {
        primary: isDark ? "#E7EFFA" : "#132138",
        secondary: isDark ? "#A9B8D1" : "#395473",
      },
      divider: isDark ? "rgba(167,187,219,0.12)" : "rgba(19,33,56,0.10)",
      warning: {
        main: "#CC6F4E",
      },
    },
    shape: {
      borderRadius: 18,
    },
    typography: {
      fontFamily: '"Manrope", "Segoe UI", sans-serif',
      h1: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      h2: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      h3: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      h4: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      h5: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      h6: { fontFamily: '"Space Grotesk", "Manrope", sans-serif', fontWeight: 700 },
      button: { textTransform: "none", fontWeight: 700, letterSpacing: "0.01em" },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            background: isDark
              ? "radial-gradient(circle at 14% 10%, rgba(212,107,140,0.10), transparent 38%), radial-gradient(circle at 86% 14%, rgba(89,145,226,0.16), transparent 46%), #0F172A"
              : "radial-gradient(circle at 15% 18%, rgba(212,107,140,0.14), transparent 38%), radial-gradient(circle at 82% 12%, rgba(89,145,226,0.16), transparent 46%), #E2E9F3",
            color: isDark ? "#E7EFFA" : "#132138",
          },
          "::selection": {
            backgroundColor: alpha("#D46B8C", isDark ? 0.34 : 0.26),
            color: isDark ? "#F8FBFF" : "#132138",
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            background: isDark ? "rgba(14, 20, 34, 0.72)" : "rgba(255,255,255,0.72)",
            boxShadow: isDark
              ? "0 18px 36px rgba(2,6,18,0.42), inset 0 1px 0 rgba(255,255,255,0.06)"
              : "0 18px 36px rgba(23,40,69,0.08), inset 0 1px 0 rgba(255,255,255,0.8)",
            color: isDark ? "#E7EFFA" : "#132138",
            borderBottom: isDark ? "1px solid rgba(167,187,219,0.08)" : "1px solid rgba(255,255,255,0.55)",
            backdropFilter: "blur(16px) saturate(140%)",
            backgroundImage: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            color: isDark ? "#E7EFFA" : "#132138",
            background: isDark ? "rgba(12,18,30,0.92)" : "rgba(248,251,255,0.92)",
            backgroundImage: "none",
            backdropFilter: "blur(18px) saturate(140%)",
            borderRight: isDark ? "1px solid rgba(167,187,219,0.10)" : "1px solid rgba(255,255,255,0.6)",
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
          },
        },
      },
      MuiButton: {
        defaultProps: {
          disableElevation: true,
        },
        styleOverrides: {
          root: {
            borderRadius: 14,
            paddingInline: 14,
            transition: "transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease",
          },
          contained: {
            boxShadow: isDark
              ? "0 10px 22px rgba(2,6,18,0.24), inset 0 1px 0 rgba(255,255,255,0.14)"
              : "0 10px 22px rgba(19,33,56,0.12), inset 0 1px 0 rgba(255,255,255,0.35)",
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: isDark
                ? "0 14px 28px rgba(2,6,18,0.34), inset 0 1px 0 rgba(255,255,255,0.16)"
                : "0 14px 28px rgba(19,33,56,0.16), inset 0 1px 0 rgba(255,255,255,0.45)",
            },
          },
          outlined: {
            borderColor: isDark ? "rgba(167,187,219,0.16)" : "rgba(19,33,56,0.12)",
            background: isDark ? "rgba(17,24,39,0.42)" : "rgba(255,255,255,0.54)",
            "&:hover": {
              borderColor: isDark ? "rgba(167,187,219,0.28)" : "rgba(19,33,56,0.2)",
              background: isDark ? "rgba(20,30,48,0.62)" : "rgba(255,255,255,0.78)",
              transform: "translateY(-1px)",
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 14,
            transition: "transform 180ms ease, background-color 180ms ease, box-shadow 180ms ease",
            "&:hover": {
              transform: "translateY(-1px) scale(1.02)",
              backgroundColor: isDark ? "rgba(20,30,48,0.66)" : "rgba(255,255,255,0.72)",
              boxShadow: isDark ? "0 8px 18px rgba(2,6,18,0.22)" : "0 8px 18px rgba(19,33,56,0.08)",
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: 12,
            backgroundColor: "rgba(10, 14, 24, 0.92)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 14px 34px rgba(10,18,30,0.26)",
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: isDark ? "1px solid rgba(167,187,219,0.12)" : "1px solid rgba(255,255,255,0.68)",
            background: isDark ? "rgba(14,20,34,0.9)" : "rgba(247,250,255,0.9)",
            boxShadow: isDark
              ? "0 16px 38px rgba(2,6,18,0.34), inset 0 1px 0 rgba(255,255,255,0.04)"
              : "0 16px 38px rgba(19,33,56,0.12), inset 0 1px 0 rgba(255,255,255,0.8)",
            backdropFilter: "blur(14px)",
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              borderRadius: 14,
              background: isDark ? "rgba(17,24,39,0.58)" : "rgba(255,255,255,0.72)",
              boxShadow: isDark ? "inset 0 1px 0 rgba(255,255,255,0.04)" : "inset 0 1px 0 rgba(255,255,255,0.75)",
            },
          },
        },
      },
      MuiFormControl: {
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              borderRadius: 14,
              background: isDark ? "rgba(17,24,39,0.58)" : "rgba(255,255,255,0.72)",
              boxShadow: isDark ? "inset 0 1px 0 rgba(255,255,255,0.04)" : "inset 0 1px 0 rgba(255,255,255,0.75)",
            },
          },
        },
      },
      MuiPaginationItem: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            transition: "transform 160ms ease, background-color 160ms ease",
            "&:hover": {
              transform: "translateY(-1px)",
            },
          },
        },
      },
    },
  });

  theme = responsiveFontSizes(theme);
  return theme;
};

export default function App() {
  const [preferredThemeMode, setPreferredThemeMode] = useState(getInitialThemeMode);
  const [routePath, setRoutePath] = useState(getHashPath);
  const effectiveThemeMode = isViewerPath(routePath) ? "dark" : preferredThemeMode;
  const theme = useMemo(() => buildTheme(effectiveThemeMode), [effectiveThemeMode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-soft-theme", effectiveThemeMode);
    document.body.setAttribute("data-soft-theme", effectiveThemeMode);
  }, [effectiveThemeMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(THEME_STORAGE_KEY, preferredThemeMode);
  }, [preferredThemeMode]);

  const toggleThemeMode = () => setPreferredThemeMode((prev) => (prev === "dark" ? "light" : "dark"));

  return (
    <ThemeModeContext.Provider value={{ themeMode: effectiveThemeMode, toggleThemeMode }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <HashRouter>
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <Parent>
              <RouteThemeBridge onPathChange={setRoutePath} />
              <RouteAwareOverlays />
              <Suspense fallback={<Loading />}>
                <Routes>
                <Route path="*" element={<NotFound />} />
                <Route
                  exact
                  path="/"
                  element={
                    <>
                      <Navbar />
                      <Vods />
                    </>
                  }
                />
                <Route
                  exact
                  path="/vods"
                  element={
                    <>
                      <Navbar />
                      <Vods />
                    </>
                  }
                />
                <Route exact path="/youtube/:vodId" element={<YoutubeVod />} />
                <Route exact path="/cdn/:vodId" element={<CustomVod type="cdn" />} />
                <Route exact path="/games/:vodId" element={<Games />} />
                <Route
                  exact
                  path="/admin"
                  element={
                    <>
                      <Navbar />
                      <AdminPage />
                    </>
                  }
                />
                </Routes>
              </Suspense>
            </Parent>
          </LocalizationProvider>
        </HashRouter>
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

function RouteThemeBridge({ onPathChange }) {
  const location = useLocation();

  useEffect(() => {
    onPathChange(location.pathname || "/");
  }, [location.pathname, onPathChange]);

  return null;
}

function RouteAwareOverlays() {
  const location = useLocation();
  const path = location.pathname || "/";
  const isViewerRoute = path.startsWith("/youtube/") || path.startsWith("/cdn/") || path.startsWith("/games/");
  const showFloatingToggle = !isViewerRoute;
  const showBackdrop = path === "/" || path === "/vods";
  const footerAwareBottom = path === "/" || path === "/vods" ? { xs: 72, md: 80 } : { xs: 20, md: 26 };

  return (
    <>
      {showBackdrop && <LiquidBackdrop />}
      {showFloatingToggle && (
        <ThemeModeToggle
          announceKey={`floating-${path}`}
          sx={{
            position: "fixed",
            bottom: footerAwareBottom,
            left: { xs: 10, md: 14 },
            zIndex: 1500,
            width: 42,
            height: 42,
          }}
        />
      )}
    </>
  );
}

const Parent = styled((props) => <div {...props} />)`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  isolation: isolate;
`;
