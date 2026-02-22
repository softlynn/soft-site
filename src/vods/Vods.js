import { useEffect, useState, useMemo } from "react";
import {
  Box,
  Typography,
  Pagination,
  Grid,
  useMediaQuery,
  PaginationItem,
  TextField,
  InputAdornment,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Chip,
  Stack,
} from "@mui/material";
import SimpleBar from "simplebar-react";
import ErrorBoundary from "../utils/ErrorBoundary";
import AdSense from "react-adsense";
import Footer from "../utils/Footer";
import Loading from "../utils/Loading";
import Vod from "./Vod";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import dayjs from "dayjs";
import debounce from "lodash.debounce";
import vodsClient from "./client";
import {
  ADSENSE_CLIENT,
  ADSENSE_SLOT,
  ENABLE_ADSENSE,
  START_DATE,
  SITE_DESCRIPTION,
  SITE_TITLE,
  SOCIAL_LINKS,
  GITHUB_ISSUES_URL,
} from "../config/site";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import LiveTvRoundedIcon from "@mui/icons-material/LiveTvRounded";
import RocketLaunchRoundedIcon from "@mui/icons-material/RocketLaunchRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import Reveal from "../utils/Reveal";

const FILTERS = ["Default", "Date", "Title", "Game"];
const PLATFORMS = ["All", "Twitch", "Kick"];

const extractTwitchChannel = (url) => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  const match = normalized.match(/twitch\.tv\/([^/?#]+)/i);
  return match?.[1] || normalized;
};

function TwitchLiveEmbedCard() {
  const channel = extractTwitchChannel(SOCIAL_LINKS.twitch);
  const [hostName, setHostName] = useState("localhost");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname || "localhost";
    setHostName(host);
  }, []);

  if (!channel) {
    return (
      <Box className="soft-live-frame soft-grid-pattern" sx={{ aspectRatio: "16 / 9", p: 2, display: "grid", placeItems: "center" }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Twitch channel link is not configured.
        </Typography>
      </Box>
    );
  }

  const src = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(hostName)}&autoplay=false&muted=true`;

  return (
    <Box className="soft-live-frame soft-grid-pattern" sx={{ aspectRatio: "16 / 9", width: "100%" }}>
      <Box className="soft-star" sx={{ top: 18, right: 20, zIndex: 3 }} />
      <Box className="soft-star" sx={{ top: 48, right: 60, zIndex: 3, transform: "scale(.65)", animationDelay: "-1.8s" }} />
      <iframe
        title={`${channel} Twitch Live`}
        src={src}
        width="100%"
        height="100%"
        allowFullScreen
        frameBorder="0"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </Box>
  );
}

function StatChip({ icon, label, value }) {
  return (
    <Box
      className="soft-glass soft-surface-float"
      sx={{
        borderRadius: "16px",
        px: 1.25,
        py: 0.9,
        minWidth: 132,
        display: "flex",
        alignItems: "center",
        gap: 1,
      }}
    >
      <Box
        sx={{
          width: 30,
          height: 30,
          borderRadius: "10px",
          background: "linear-gradient(180deg, rgba(212,107,140,.16), rgba(121,163,230,.14))",
          display: "grid",
          placeItems: "center",
          color: "secondary.main",
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary", lineHeight: 1.15 }}>
          {label}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 800, color: "text.primary", lineHeight: 1.1 }}>
          {value}
        </Typography>
      </Box>
    </Box>
  );
}

export default function Vods() {
  const navigate = useNavigate();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const isMobile = useMediaQuery("(max-width: 900px)");
  const isHomeRoute = location.pathname === "/";

  const [vods, setVods] = useState(null);
  const [previewVods, setPreviewVods] = useState(isHomeRoute ? null : []);
  const [totalVods, setTotalVods] = useState(null);
  const [filter, setFilter] = useState(FILTERS[0]);
  const [filterStartDate, setFilterStartDate] = useState(dayjs(START_DATE));
  const [filterEndDate, setFilterEndDate] = useState(dayjs());
  const [filterTitle, setFilterTitle] = useState("");
  const [filterGame, setFilterGame] = useState("");
  const [platform, setPlatform] = useState(PLATFORMS[0]);
  const page = parseInt(query.get("page") || "1", 10);
  const limit = isMobile ? 10 : 20;
  const previewLimit = isMobile ? 4 : 6;

  useEffect(() => {
    document.title = isHomeRoute ? `${SITE_TITLE} | Vod Archive` : `${SITE_TITLE} | Archive`;
  }, [isHomeRoute]);

  useEffect(() => {
    if (!isHomeRoute) return undefined;
    setPreviewVods(null);

    vodsClient
      .service("vods")
      .find({
        query: {
          $limit: previewLimit,
          $skip: 0,
          $sort: { createdAt: -1 },
          $and: [{ unpublished: { $ne: true } }],
        },
      })
      .then((response) => {
        const visible = Array.isArray(response.data) ? response.data.filter((vod) => !vod?.unpublished) : [];
        setPreviewVods(visible.slice(0, previewLimit));
      })
      .catch((error) => {
        console.error(error);
        setPreviewVods([]);
      });

    return undefined;
  }, [isHomeRoute, previewLimit]);

  useEffect(() => {
    setVods(null);
    const fetchVods = async () => {
      let nextQuery = {
        $limit: limit,
        $skip: (page - 1) * limit,
        $sort: {
          createdAt: -1,
        },
        $and: [
          {
            unpublished: {
              $ne: true,
            },
          },
        ],
      };

      if (platform !== PLATFORMS[0]) {
        nextQuery.$and.push({ platform: platform.toLowerCase() });
      }

      switch (filter) {
        case "Date":
          if (filterStartDate > filterEndDate) {
            nextQuery = null;
            break;
          }
          nextQuery.$and.push({
            createdAt: {
              $gte: filterStartDate.toISOString(),
              $lte: filterEndDate.toISOString(),
            },
          });
          break;
        case "Title":
          if (filterTitle.length === 0) {
            nextQuery = null;
            break;
          }
          nextQuery.$and.push({
            title: {
              $iLike: `%${filterTitle}%`,
            },
          });
          break;
        case "Game":
          if (filterGame.length === 0) {
            nextQuery = null;
            break;
          }
          if (platform === PLATFORMS[0]) {
            nextQuery.chapters = {
              name: filterGame,
            };
          } else {
            nextQuery.$and.push({
              chapters: {
                name: filterGame,
              },
            });
          }
          break;
        default:
          break;
      }

      if (nextQuery == null) return;

      vodsClient
        .service("vods")
        .find({
          query: nextQuery,
        })
        .then((response) => {
          const visibleVods = Array.isArray(response.data) ? response.data.filter((vod) => !vod?.unpublished) : [];
          setVods(visibleVods);
          if (typeof response.total === "number") {
            const hiddenOnPage = (Array.isArray(response.data) ? response.data.length : 0) - visibleVods.length;
            setTotalVods(Math.max(0, response.total - Math.max(0, hiddenOnPage)));
            return;
          }
          setTotalVods(visibleVods.length);
        })
        .catch((e) => {
          console.error(e);
        });
    };

    fetchVods();
    return undefined;
  }, [limit, page, filter, filterStartDate, filterEndDate, filterTitle, filterGame, platform]);

  const changeFilter = (evt) => {
    setFilter(evt.target.value);
    navigate(`${location.pathname}?page=1`);
  };

  const changePlatform = (evt) => {
    setPlatform(evt.target.value);
    navigate(`${location.pathname}?page=1`);
  };

  const handleSubmit = (e) => {
    const value = e.target.value;
    if (e.which === 13 && !isNaN(value) && value > 0) {
      navigate(`${location.pathname}?page=${value}`);
    }
  };

  const debouncedSetFilterTitle = useMemo(
    () =>
      debounce((value) => {
        setFilterTitle(value);
      }, 350),
    []
  );

  const debouncedSetFilterGame = useMemo(
    () =>
      debounce((value) => {
        setFilterGame(value);
      }, 350),
    []
  );

  useEffect(() => {
    return () => {
      debouncedSetFilterTitle.cancel();
      debouncedSetFilterGame.cancel();
    };
  }, [debouncedSetFilterGame, debouncedSetFilterTitle]);

  const handleTitleChange = (evt) => {
    const value = evt.target.value;
    if (!value) {
      debouncedSetFilterTitle.cancel();
      setFilterTitle("");
      return;
    }
    debouncedSetFilterTitle(value);
  };

  const handleGameChange = (evt) => {
    const value = evt.target.value;
    if (!value) {
      debouncedSetFilterGame.cancel();
      setFilterGame("");
      return;
    }
    debouncedSetFilterGame(value);
  };

  const totalPages = Math.max(1, Math.ceil((totalVods || 0) / limit));

  const scrollToArchive = () => {
    const node = document.getElementById("home-archive-section");
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const renderArchiveControls = () => (
    <Box className="soft-glass soft-grid-pattern" sx={{ px: { xs: 1.25, md: 2 }, py: 1.25, borderRadius: "22px" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: { xs: "flex-start", md: "center" }, gap: 1.5, flexDirection: { xs: "column", md: "row" } }}>
        <Box>
          <Typography variant="h5" sx={{ color: "primary.main" }}>
            Full VOD Archive
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Search, filter, and jump into any stream with chat replay.
          </Typography>
        </Box>
        {totalVods !== null && (
          <Chip
            icon={<VideoLibraryRoundedIcon sx={{ fontSize: 16 }} />}
            label={`${totalVods} vod${totalVods === 1 ? "" : "s"}`}
            sx={{
              borderRadius: "999px",
              background: "rgba(255,255,255,.7)",
              border: "1px solid rgba(255,255,255,.74)",
              fontWeight: 700,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.86)",
            }}
          />
        )}
      </Box>

      <Box
        sx={{
          mt: 1.25,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "auto auto 1fr auto" },
          gap: 1,
          alignItems: "center",
        }}
      >
        <FormControl sx={{ minWidth: 130 }}>
          <InputLabel id="filter-select-label">Filter</InputLabel>
          <Select labelId="filter-select-label" label="Filter" value={filter} onChange={changeFilter}>
            {FILTERS.map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {filter === "Date" ? (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <DatePicker
              minDate={dayjs(START_DATE)}
              maxDate={dayjs()}
              label="Start Date"
              defaultValue={filterStartDate}
              onAccept={(newDate) => setFilterStartDate(newDate)}
              views={["year", "month", "day"]}
              slotProps={{ textField: { size: "small" } }}
            />
            <DatePicker
              minDate={dayjs(START_DATE)}
              maxDate={dayjs()}
              label="End Date"
              defaultValue={filterEndDate}
              onAccept={(newDate) => setFilterEndDate(newDate)}
              views={["year", "month", "day"]}
              slotProps={{ textField: { size: "small" } }}
            />
          </Stack>
        ) : filter === "Title" ? (
          <TextField size="small" fullWidth label="Search by Title" type="text" onChange={handleTitleChange} defaultValue={filterTitle} />
        ) : filter === "Game" ? (
          <TextField size="small" fullWidth label="Search by Game" type="text" onChange={handleGameChange} defaultValue={filterGame} />
        ) : (
          <Box />
        )}

        <FormControl sx={{ minWidth: 110 }}>
          <InputLabel id="platform-select-label">Platform</InputLabel>
          <Select labelId="platform-select-label" label="Platform" value={platform} onChange={changePlatform}>
            {PLATFORMS.map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );

  const renderVodGrid = (list, cardSizes) => {
    if (!list) return <Loading />;
    if (list.length === 0) {
      return (
        <Box className="soft-glass" sx={{ p: 2, borderRadius: "20px", textAlign: "center" }}>
          <Typography variant="body1" sx={{ color: "text.secondary" }}>
            No VODs found yet. Upload to YouTube and the archive will sync automatically.
          </Typography>
        </Box>
      );
    }

    return (
      <Grid container spacing={2} sx={{ mt: 0.5, justifyContent: "center" }}>
        {list.map((vod, index) => (
          <Reveal key={vod.id} delay={Math.min(index * 40, 220)} sx={{ display: "contents" }}>
            <Vod vod={vod} sizes={cardSizes} gridSize={2.1} />
          </Reveal>
        ))}
      </Grid>
    );
  };

  return (
    <SimpleBar style={{ minHeight: 0, height: "100%" }}>
      <Box sx={{ px: { xs: 1.25, sm: 2 }, pb: 1 }}>
        {ENABLE_ADSENSE && ADSENSE_CLIENT && ADSENSE_SLOT && (
          <Box sx={{ mt: 1, textAlign: "center" }}>
            <ErrorBoundary>
              <AdSense.Google client={ADSENSE_CLIENT} slot={ADSENSE_SLOT} style={{ display: "block" }} format="auto" responsive="true" layoutKey="-gw-1+2a-9x+5c" />
            </ErrorBoundary>
          </Box>
        )}

        {isHomeRoute && (
          <>
            <Reveal delay={40} sx={{ mt: { xs: 0.5, md: 1 } }}>
              <Box className="soft-glass soft-grid-pattern soft-hero-glow" sx={{ p: { xs: 1.2, sm: 1.8, md: 2.2 }, borderRadius: "28px" }}>
                <Grid container spacing={{ xs: 1.5, md: 2.5 }} alignItems="stretch">
                  <Grid size={{ xs: 12, lg: 5 }}>
                    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", gap: 1.35, justifyContent: "center", pr: { lg: 1 } }}>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                        <Chip
                          icon={<LiveTvRoundedIcon sx={{ fontSize: 16 }} />}
                          label="Live Twitch Embed"
                          sx={{
                            borderRadius: "999px",
                            background: "rgba(212,107,140,.15)",
                            border: "1px solid rgba(212,107,140,.24)",
                            color: "#7f2946",
                            fontWeight: 700,
                          }}
                        />
                        <Chip
                          icon={<AutoAwesomeRoundedIcon sx={{ fontSize: 16 }} />}
                          label="Chat Replay Archive"
                          sx={{
                            borderRadius: "999px",
                            background: "rgba(121,163,230,.12)",
                            border: "1px solid rgba(121,163,230,.24)",
                            color: "#214a88",
                            fontWeight: 700,
                          }}
                        />
                      </Stack>

                      <Box>
                        <Typography
                          variant="h2"
                          sx={{
                            fontSize: { xs: "2.05rem", sm: "2.8rem", md: "3.2rem" },
                            lineHeight: 0.96,
                            color: "primary.main",
                            letterSpacing: "-0.03em",
                          }}
                        >
                          {SITE_TITLE}
                        </Typography>
                        <Typography
                          variant="h4"
                          sx={{
                            mt: 0.5,
                            fontSize: { xs: "1.15rem", sm: "1.35rem" },
                            color: "secondary.main",
                            letterSpacing: "-0.02em",
                          }}
                        >
                          Vod Archive
                        </Typography>
                      </Box>

                      <Typography variant="body1" sx={{ color: "text.secondary", maxWidth: 540 }}>
                        {SITE_DESCRIPTION} Watch live, jump into recent uploads, then scroll into the full archive with filters and internal VOD pages.
                      </Typography>

                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ pt: 0.5 }}>
                        <Button
                          variant="contained"
                          color="secondary"
                          size="large"
                          startIcon={<ArrowDownwardRoundedIcon />}
                          onClick={scrollToArchive}
                          sx={{
                            borderRadius: "14px",
                            px: 2,
                            background: "linear-gradient(180deg, #D46B8C 0%, #C85E80 100%)",
                            color: "#fff",
                          }}
                        >
                          Browse Archive
                        </Button>
                        {SOCIAL_LINKS.twitch && (
                          <Button
                            component="a"
                            href={SOCIAL_LINKS.twitch}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="outlined"
                            size="large"
                            startIcon={<OpenInNewRoundedIcon />}
                            sx={{ borderRadius: "14px", px: 2 }}
                          >
                            Open Twitch
                          </Button>
                        )}
                        {GITHUB_ISSUES_URL && (
                          <Button
                            component="a"
                            href={GITHUB_ISSUES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="outlined"
                            size="large"
                            startIcon={<RocketLaunchRoundedIcon />}
                            sx={{ borderRadius: "14px", px: 2 }}
                          >
                            Issues
                          </Button>
                        )}
                      </Stack>

                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} useFlexGap flexWrap="wrap" sx={{ pt: 0.2 }}>
                        <StatChip icon={<BoltRoundedIcon sx={{ fontSize: 16 }} />} label="Design mood" value="Liquid glass" />
                        <StatChip icon={<AutoAwesomeRoundedIcon sx={{ fontSize: 16 }} />} label="Motif" value="Clouds + Stars" />
                        <StatChip icon={<VideoLibraryRoundedIcon sx={{ fontSize: 16 }} />} label="Brand" value="softu" />
                      </Stack>
                    </Box>
                  </Grid>

                  <Grid size={{ xs: 12, lg: 7 }}>
                    <Reveal delay={140}>
                      <TwitchLiveEmbedCard />
                    </Reveal>
                  </Grid>
                </Grid>
              </Box>
            </Reveal>

            <Reveal delay={120} sx={{ mt: 2 }}>
              <Box className="soft-glass" sx={{ p: { xs: 1.2, md: 1.5 }, borderRadius: "24px" }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5, flexWrap: "wrap" }}>
                  <Box>
                    <Typography variant="h5" sx={{ color: "primary.main" }}>
                      Recent VODs
                    </Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      A quick preview. Scroll down for the full archive browser.
                    </Typography>
                  </Box>
                  <Button variant="outlined" onClick={() => navigate("/vods")} startIcon={<VideoLibraryRoundedIcon />}>
                    Open Full VODs Page
                  </Button>
                </Box>

                {previewVods === null ? <Loading /> : renderVodGrid(previewVods, { xs: 12, sm: 6, lg: 4 })}
              </Box>
            </Reveal>
          </>
        )}

        <Reveal delay={isHomeRoute ? 180 : 40} sx={{ mt: 2.25 }} id="home-archive-section">
          {renderArchiveControls()}
        </Reveal>

        <Box sx={{ mt: 1.2 }}>{renderVodGrid(vods, { xs: 12, sm: 6, md: 4, xl: 3 })}</Box>

        <Box sx={{ display: "flex", justifyContent: "center", mt: 2.5, mb: 1.2, alignItems: "center", flexDirection: isMobile ? "column" : "row" }}>
          {totalPages !== null && (
            <>
              <Pagination
                shape="rounded"
                variant="outlined"
                count={totalPages}
                disabled={totalPages <= 1}
                color="primary"
                page={page}
                renderItem={(item) => <PaginationItem component={Link} to={`${location.pathname}${item.page === 1 ? "" : `?page=${item.page}`}`} {...item} />}
              />
              <TextField
                inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
                InputProps={{
                  startAdornment: <InputAdornment position="start">Page</InputAdornment>,
                }}
                sx={{
                  width: "116px",
                  m: 1,
                }}
                size="small"
                type="text"
                onKeyDown={handleSubmit}
              />
            </>
          )}
        </Box>
      </Box>
      <Footer />
    </SimpleBar>
  );
}
