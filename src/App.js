import { lazy, Suspense } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { alpha, createTheme, ThemeProvider, responsiveFontSizes } from "@mui/material/styles";
import { CssBaseline, styled } from "@mui/material";
import Loading from "./utils/Loading";
import { LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import LiquidBackdrop from "./utils/LiquidBackdrop";

const Vods = lazy(() => import("./vods/Vods"));
const YoutubeVod = lazy(() => import("./vods/YoutubeVod"));
const CustomVod = lazy(() => import("./vods/CustomVod"));
const Games = lazy(() => import("./games/Games"));
const Navbar = lazy(() => import("./navbar/Navbar"));
const NotFound = lazy(() => import("./utils/NotFound"));
const AdminPage = lazy(() => import("./admin/AdminPage"));

export default function App() {
  let darkTheme = createTheme({
    palette: {
      mode: "light",
      background: {
        default: "#E2E9F3",
        paper: "rgba(255,255,255,0.72)",
      },
      primary: {
        main: "#132138",
      },
      secondary: {
        main: "#D46B8C",
      },
      text: {
        primary: "#132138",
        secondary: "#395473",
      },
      divider: "rgba(19,33,56,0.10)",
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
            background:
              "radial-gradient(circle at 15% 18%, rgba(212,107,140,0.14), transparent 38%), radial-gradient(circle at 82% 12%, rgba(89,145,226,0.16), transparent 46%), #E2E9F3",
            color: "#132138",
          },
          "::selection": {
            backgroundColor: alpha("#D46B8C", 0.26),
            color: "#132138",
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            background: "rgba(255,255,255,0.72)",
            boxShadow: "0 18px 36px rgba(23,40,69,0.08), inset 0 1px 0 rgba(255,255,255,0.8)",
            color: "#132138",
            borderBottom: "1px solid rgba(255,255,255,0.55)",
            backdropFilter: "blur(16px) saturate(140%)",
            backgroundImage: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            color: "#132138",
            background: "rgba(248,251,255,0.92)",
            backgroundImage: "none",
            backdropFilter: "blur(18px) saturate(140%)",
            borderRight: "1px solid rgba(255,255,255,0.6)",
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
            boxShadow: "0 10px 22px rgba(19,33,56,0.12), inset 0 1px 0 rgba(255,255,255,0.35)",
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: "0 14px 28px rgba(19,33,56,0.16), inset 0 1px 0 rgba(255,255,255,0.45)",
            },
          },
          outlined: {
            borderColor: "rgba(19,33,56,0.12)",
            background: "rgba(255,255,255,0.54)",
            "&:hover": {
              borderColor: "rgba(19,33,56,0.2)",
              background: "rgba(255,255,255,0.78)",
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
              backgroundColor: "rgba(255,255,255,0.72)",
              boxShadow: "0 8px 18px rgba(19,33,56,0.08)",
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: 12,
            backgroundColor: "rgba(17, 28, 49, 0.92)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 14px 34px rgba(10,18,30,0.26)",
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.68)",
            background: "rgba(247,250,255,0.9)",
            boxShadow: "0 16px 38px rgba(19,33,56,0.12), inset 0 1px 0 rgba(255,255,255,0.8)",
            backdropFilter: "blur(14px)",
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              borderRadius: 14,
              background: "rgba(255,255,255,0.72)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.75)",
            },
          },
        },
      },
      MuiFormControl: {
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              borderRadius: 14,
              background: "rgba(255,255,255,0.72)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.75)",
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

  darkTheme = responsiveFontSizes(darkTheme);

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <HashRouter>
        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <Parent>
            <LiquidBackdrop />
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
