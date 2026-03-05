import { lazy, Suspense, useEffect, useState, useMemo, useRef } from "react";
import {
  Box,
  Typography,
  Pagination,
  Grid,
  useMediaQuery,
  PaginationItem,
  TextField,
  InputAdornment,
  Button,
  Stack,
} from "@mui/material";
import SimpleBar from "simplebar-react";
import ErrorBoundary from "../utils/ErrorBoundary";
import AdSense from "react-adsense";
import Footer from "../utils/Footer";
import Loading from "../utils/Loading";
import Vod from "./Vod";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
} from "../config/site";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import Reveal from "../utils/Reveal";
import TypeGpuButtonOverlay from "../utils/TypeGpuButtonOverlay";
import { fetchActiveVodUploads } from "../api/uploadStatusApi";
import UploadingVodPlaceholder from "./UploadingVodPlaceholder";

const FILTERS = ["Default", "Date", "Title", "Game"];
const PLATFORMS = ["All", "Twitch", "Kick"];
const SPOTIFY_PLAYLIST_EMBED_URL = "https://open.spotify.com/embed/playlist/39yiDX8UItwk0hakJdFM93?utm_source=generator";
const ArchiveControls = lazy(() => import("./ArchiveControls"));

const normalizeUploadForCompare = (upload) => ({
  sessionId: String(upload?.sessionId || "").trim(),
  state: String(upload?.state || "").trim().toLowerCase(),
  twitchVodId: String(upload?.twitchVodId || "").trim(),
  partNumber: Number.isFinite(Number(upload?.partNumber)) ? Number(upload.partNumber) : null,
  percent: Number.isFinite(Number(upload?.percent)) ? Math.round(Number(upload.percent) * 100) / 100 : null,
  uploadedBytes: Number.isFinite(Number(upload?.uploadedBytes)) ? Number(upload.uploadedBytes) : null,
  totalBytes: Number.isFinite(Number(upload?.totalBytes)) ? Number(upload.totalBytes) : null,
  updatedAtMs: Number.isFinite(Number(upload?.updatedAtMs)) ? Number(upload.updatedAtMs) : null,
  createdAtMs: Number.isFinite(Number(upload?.createdAtMs)) ? Number(upload.createdAtMs) : null,
  title: String(upload?.title || ""),
  recordingName: String(upload?.recordingName || ""),
  message: String(upload?.message || ""),
  streamDate: String(upload?.streamDate || ""),
});

const buildUploadCompareKey = (uploads) =>
  (Array.isArray(uploads) ? uploads : [])
    .map(normalizeUploadForCompare)
    .sort((a, b) => {
      if (a.sessionId === b.sessionId) {
        const partA = Number.isFinite(a.partNumber) ? a.partNumber : 0;
        const partB = Number.isFinite(b.partNumber) ? b.partNumber : 0;
        return partA - partB;
      }
      return a.sessionId.localeCompare(b.sessionId);
    })
    .map((item) => JSON.stringify(item))
    .join("|");

const areActiveUploadsEquivalent = (a, b) => buildUploadCompareKey(a) === buildUploadCompareKey(b);

const normalizeUploadVodId = (upload) => {
  const id = String(upload?.twitchVodId || "").trim();
  return id || null;
};

const buildVodListWithUploadPlaceholders = (list, activeUploads) => {
  const realList = Array.isArray(list) ? list : [];
  const uploads = Array.isArray(activeUploads) ? activeUploads : [];
  if (uploads.length === 0) return realList;

  const existingVodPartNumbersById = new Map();
  for (const vod of realList) {
    const vodId = String(vod?.id || "").trim();
    if (!vodId) continue;
    const partSet = new Set(
      (Array.isArray(vod?.youtube) ? vod.youtube : [])
        .filter((part) => String(part?.type || "vod") === "vod")
        .map((part) => Number(part?.part))
        .filter((value) => Number.isFinite(value) && value > 0)
    );
    existingVodPartNumbersById.set(vodId, partSet);
  }
  const seenSessionIds = new Set();

  const placeholders = uploads
    .filter((upload) => {
      const sessionId = String(upload?.sessionId || "").trim();
      if (!sessionId || seenSessionIds.has(sessionId)) return false;
      seenSessionIds.add(sessionId);

      const state = String(upload?.state || "").trim().toLowerCase();
      if (!state || state === "done" || state === "error") return false;

      const uploadVodId = normalizeUploadVodId(upload);
      if (uploadVodId && existingVodPartNumbersById.has(uploadVodId)) {
        const existingPartSet = existingVodPartNumbersById.get(uploadVodId);
        const uploadPartNumber = Number(upload?.partNumber);
        if (Number.isFinite(uploadPartNumber) && existingPartSet?.has(Math.max(1, Math.floor(uploadPartNumber)))) {
          return false;
        }
      }
      return true;
    })
    .map((upload, index) => ({
      __type: "upload-placeholder",
      __key: `upload-${String(upload?.sessionId || index)}`,
      upload,
    }));

  if (placeholders.length === 0) return realList;
  return [...placeholders, ...realList];
};

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
  const frameRef = useRef(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [shouldLoadPlayer, setShouldLoadPlayer] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.hostname || "localhost";
    setHostName(host);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const node = frameRef.current;
    if (!node || typeof window.IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return undefined;
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      {
        root: null,
        threshold: 0,
        rootMargin: "240px 0px",
      }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport || shouldLoadPlayer || typeof window === "undefined") return undefined;
    let canceled = false;
    let timeoutId = null;

    const activate = () => {
      if (!canceled) setShouldLoadPlayer(true);
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(
        () => {
          timeoutId = window.setTimeout(activate, 80);
        },
        { timeout: 700 }
      );
      return () => {
        canceled = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        try {
          window.cancelIdleCallback(idleId);
        } catch {
          // no-op
        }
      };
    }

    timeoutId = window.setTimeout(activate, 140);
    return () => {
      canceled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isNearViewport, shouldLoadPlayer]);

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
    <Box ref={frameRef} className="soft-live-frame soft-grid-pattern" sx={{ aspectRatio: "16 / 9", width: "100%" }}>
      <Box className="soft-star" sx={{ top: 18, right: 20, zIndex: 3 }} />
      <Box className="soft-star" sx={{ top: 48, right: 60, zIndex: 3, transform: "scale(.65)", animationDelay: "-1.8s" }} />
      {shouldLoadPlayer ? (
        <iframe
          title={`${channel} Twitch Live`}
          src={src}
          width="100%"
          height="100%"
          allowFullScreen
          frameBorder="0"
          loading="lazy"
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      ) : (
        <Box
          aria-hidden
          sx={{
            width: "100%",
            height: "100%",
            background:
              "radial-gradient(circle at 24% 18%, rgba(212,107,140,0.22), transparent 42%), radial-gradient(circle at 78% 24%, rgba(121,163,230,0.22), transparent 44%), linear-gradient(180deg, rgba(19,33,56,0.88), rgba(14,24,42,0.96))",
          }}
        />
      )}
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
  const [activeUploads, setActiveUploads] = useState([]);
  const [vodListRefreshNonce, setVodListRefreshNonce] = useState(0);
  const [totalVods, setTotalVods] = useState(null);
  const [filter, setFilter] = useState(FILTERS[0]);
  const [filterStartDate, setFilterStartDate] = useState(dayjs(START_DATE));
  const [filterEndDate, setFilterEndDate] = useState(dayjs());
  const [filterTitle, setFilterTitle] = useState("");
  const [filterGame, setFilterGame] = useState("");
  const [platform] = useState(PLATFORMS[0]);
  const page = parseInt(query.get("page") || "1", 10);
  const limit = isMobile ? 10 : 20;
  const previewLimit = isMobile ? 4 : 8;
  const uploadCompletionRefreshStateRef = useRef({
    trackedSessions: new Map(),
    completionRefetchedSessionIds: new Set(),
  });

  useEffect(() => {
    document.title = isHomeRoute ? `${SITE_TITLE} | Vod Archive` : `${SITE_TITLE} | Archive`;
  }, [isHomeRoute]);

  useEffect(() => {
    let isDisposed = false;
    let intervalId = null;

    const loadActiveUploads = async () => {
      try {
        const uploads = await fetchActiveVodUploads();
        if (!isDisposed) {
          const nextUploads = Array.isArray(uploads) ? uploads : [];
          setActiveUploads((previousUploads) => (areActiveUploadsEquivalent(previousUploads, nextUploads) ? previousUploads : nextUploads));
        }
      } catch (error) {
        if (!isDisposed) {
          console.error("Failed to load active upload placeholders:", error);
          setActiveUploads((previousUploads) => (previousUploads.length === 0 ? previousUploads : []));
        }
      }
    };

    void loadActiveUploads();
    intervalId = setInterval(loadActiveUploads, 5000);

    return () => {
      isDisposed = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const stateRef = uploadCompletionRefreshStateRef.current;
    const previousSessions = stateRef.trackedSessions;
    const nextSessions = new Map();
    let shouldRefreshVods = false;

    (Array.isArray(activeUploads) ? activeUploads : []).forEach((upload) => {
      const sessionId = String(upload?.sessionId || "").trim();
      if (!sessionId) return;

      const normalizedState = String(upload?.state || "").trim().toLowerCase();
      const percent = Number(upload?.percent);
      const uploadVodId = String(upload?.twitchVodId || "").trim();
      const previous = previousSessions.get(sessionId);

      nextSessions.set(sessionId, {
        state: normalizedState,
        percent: Number.isFinite(percent) ? percent : null,
        twitchVodId: uploadVodId,
      });

      const completionish = normalizedState === "finalizing" || (Number.isFinite(percent) && percent >= 99.5);
      if (completionish && !stateRef.completionRefetchedSessionIds.has(sessionId)) {
        stateRef.completionRefetchedSessionIds.add(sessionId);
        shouldRefreshVods = true;
      }

      if (previous && previous.twitchVodId !== uploadVodId && uploadVodId) {
        shouldRefreshVods = true;
      }
    });

    for (const sessionId of previousSessions.keys()) {
      if (!nextSessions.has(sessionId)) {
        // Upload disappeared from the active API (done/error). Refresh once so placeholders get replaced/removed.
        shouldRefreshVods = true;
        stateRef.completionRefetchedSessionIds.delete(sessionId);
      }
    }

    stateRef.trackedSessions = nextSessions;
    if (shouldRefreshVods) {
      setVodListRefreshNonce((nonce) => nonce + 1);
    }
  }, [activeUploads]);

  useEffect(() => {
    if (!isHomeRoute) return undefined;

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
  }, [isHomeRoute, previewLimit, vodListRefreshNonce]);

  useEffect(() => {
    if (isHomeRoute) return undefined;
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
  }, [isHomeRoute, limit, page, filter, filterStartDate, filterEndDate, filterTitle, filterGame, platform, vodListRefreshNonce]);

  const changeFilter = (evt) => {
    setFilter(evt.target.value);
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

  const renderVodGrid = (list, cardSizes, { edgePad = { xs: 0.05, sm: 0.15, md: 0.25 }, cardWidth } = {}) => {
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

    let realVodIndex = 0;
    return (
      <Grid
        container
        spacing={{ xs: 1.2, sm: 1.6, md: 2 }}
        sx={{
          mt: 0.5,
          justifyContent: "center",
          px: edgePad,
        }}
      >
        {list.map((item, index) => {
          if (item?.__type === "upload-placeholder") {
            return (
              <Reveal key={item.__key} delay={Math.min(index * 40, 220)} sx={{ display: "contents" }}>
                <UploadingVodPlaceholder upload={item.upload} sizes={cardSizes} cardWidth={cardWidth} />
              </Reveal>
            );
          }

          const vod = item;
          const sheen = realVodIndex === 0;
          realVodIndex += 1;
          return (
            <Reveal key={vod.id} delay={Math.min(index * 40, 220)} sx={{ display: "contents" }}>
              <Vod vod={vod} sizes={cardSizes} gridSize={2.1} sheen={sheen} cardWidth={cardWidth} />
            </Reveal>
          );
        })}
      </Grid>
    );
  };

  const homePreviewDisplayList = useMemo(() => {
    if (previewVods === null) {
      if (!Array.isArray(activeUploads) || activeUploads.length === 0) return null;
      return buildVodListWithUploadPlaceholders([], activeUploads);
    }
    return buildVodListWithUploadPlaceholders(previewVods, activeUploads);
  }, [previewVods, activeUploads]);

  const archiveDisplayList = useMemo(() => {
    if (vods === null) {
      if (!Array.isArray(activeUploads) || activeUploads.length === 0) return null;
      return buildVodListWithUploadPlaceholders([], activeUploads);
    }
    return buildVodListWithUploadPlaceholders(vods, activeUploads);
  }, [vods, activeUploads]);

  return (
    <SimpleBar className="soft-vods-scroll" style={{ minHeight: 0, height: "100%" }}>
      <Box sx={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ px: { xs: 1.25, sm: 2, md: 2.2 }, pb: 1, flexGrow: 1 }}>
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
              <Box className="soft-glass soft-grid-pattern soft-panel-ambient soft-hero-glow" sx={{ p: { xs: 1.3, sm: 1.95, md: 2.35 }, borderRadius: "28px" }}>
                <Grid container spacing={{ xs: 1.5, md: 2.5 }} alignItems="stretch">
                  <Grid size={{ xs: 12, lg: 5 }}>
                    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", gap: 1.25, justifyContent: "center", pr: { lg: 1 } }}>
                      <Box>
                        <Typography
                          variant="h2"
                          sx={{
                            fontSize: { xs: "2.05rem", sm: "2.8rem", md: "3.2rem" },
                            lineHeight: 0.96,
                            color: "primary.main",
                            letterSpacing: "-0.03em",
                            textTransform: "lowercase",
                          }}
                        >
                          softu
                        </Typography>
                        <Typography
                          variant="h4"
                          className="soft-section-heading"
                          sx={{
                            mt: 0.5,
                            fontSize: { xs: "1.02rem", sm: "1.18rem" },
                            color: "text.secondary",
                            letterSpacing: "0.01em",
                            fontWeight: 600,
                            lineHeight: 1.28,
                          }}
                        >
                          vod archives with chat replay
                        </Typography>
                      </Box>

                      <Typography variant="body1" sx={{ color: "text.secondary", maxWidth: 520, lineHeight: 1.52 }}>
                        {SITE_DESCRIPTION}
                      </Typography>

                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ pt: 0.35 }}>
                        <Button
                          variant="contained"
                          color="secondary"
                          size="large"
                          onClick={() => navigate("/vods")}
                          className="soft-cta-button soft-cta-button--salmon"
                          sx={{
                            borderRadius: "14px",
                            px: 2,
                            background: "linear-gradient(180deg, #D46B8C 0%, #C85E80 100%)",
                            color: "#fff",
                            position: "relative",
                            overflow: "hidden",
                            border: "1px solid rgba(255,255,255,0.22)",
                          }}
                        >
                          <TypeGpuButtonOverlay tone="salmon" />
                          <Box component="span" sx={{ position: "relative", zIndex: 2, display: "inline-flex", alignItems: "center", gap: 0.8 }}>
                            <VideoLibraryRoundedIcon sx={{ fontSize: 20 }} />
                            Open VODs
                          </Box>
                        </Button>
                        {SOCIAL_LINKS.twitch && (
                          <Button
                            component="a"
                            href={SOCIAL_LINKS.twitch}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="outlined"
                            size="large"
                            className="soft-cta-button soft-cta-button--blue"
                            sx={{
                              borderRadius: "14px",
                              px: 2,
                              position: "relative",
                              overflow: "hidden",
                              borderWidth: "1px",
                            }}
                          >
                            <TypeGpuButtonOverlay tone="blue" />
                            <Box component="span" sx={{ position: "relative", zIndex: 2, display: "inline-flex", alignItems: "center", gap: 0.8 }}>
                              <OpenInNewRoundedIcon sx={{ fontSize: 20 }} />
                              Twitch
                            </Box>
                          </Button>
                        )}
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

            <Reveal delay={130} sx={{ mt: 2 }}>
              <Box className="soft-glass soft-panel-ambient" sx={{ p: { xs: 1.2, md: 1.5 }, borderRadius: "24px" }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.7, flexWrap: "wrap" }}>
                  <Box>
                    <Typography variant="h5" className="soft-section-heading" sx={{ color: "primary.main" }}>
                      Recent VODs
                    </Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.35, lineHeight: 1.45, maxWidth: 560 }}>
                      Latest uploads only. Open the full VODs page for filters and the complete archive.
                    </Typography>
                  </Box>
                  <Button variant="outlined" onClick={() => navigate("/vods")} startIcon={<VideoLibraryRoundedIcon />}>
                    Open Full VODs Page
                  </Button>
                </Box>

                {homePreviewDisplayList === null
                  ? <Loading />
                  : renderVodGrid(homePreviewDisplayList, { xs: 12, sm: 6, lg: 3 }, { edgePad: { xs: 0.12, sm: 0.16, md: 0.22 }, cardWidth: "21.5rem" })}
              </Box>
            </Reveal>

            <Reveal delay={150} sx={{ mt: 1.9, display: "flex", justifyContent: "center" }}>
              <Box className="soft-glass soft-panel-ambient" sx={{ p: { xs: 0.95, md: 1.1 }, borderRadius: "20px", width: "100%", maxWidth: "430px" }}>
                <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mb: 0.75, px: 0.35, letterSpacing: "0.05em", fontWeight: 700 }}>
                  stream playlist
                </Typography>
                <Box sx={{ borderRadius: "14px", overflow: "hidden", mx: "auto" }}>
                  <iframe
                    data-testid="embed-iframe"
                    title="softu stream playlist"
                    src={SPOTIFY_PLAYLIST_EMBED_URL}
                    width="100%"
                    height="352"
                    frameBorder="0"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    loading="lazy"
                    style={{ border: 0, display: "block", borderRadius: "12px" }}
                  />
                </Box>
              </Box>
            </Reveal>
          </>
        )}

        {!isHomeRoute && (
          <>
            <Reveal delay={40} sx={{ mt: 2.25 }} id="home-archive-section">
              <Suspense
                fallback={
                  <Box
                    className="soft-glass soft-grid-pattern soft-panel-ambient"
                    sx={{
                      px: { xs: 1.25, md: 2 },
                      py: { xs: 1.25, md: 1.45 },
                      borderRadius: "22px",
                      minHeight: 118,
                    }}
                  />
                }
              >
                <ArchiveControls
                  filter={filter}
                  changeFilter={changeFilter}
                  filters={FILTERS}
                  totalVods={totalVods}
                  filterStartDate={filterStartDate}
                  filterEndDate={filterEndDate}
                  setFilterStartDate={setFilterStartDate}
                  setFilterEndDate={setFilterEndDate}
                  handleTitleChange={handleTitleChange}
                  filterTitle={filterTitle}
                  handleGameChange={handleGameChange}
                  filterGame={filterGame}
                />
              </Suspense>
            </Reveal>

            <Box sx={{ mt: 1.2 }}>{renderVodGrid(archiveDisplayList, { xs: 12, sm: 6, lg: 3, xl: 3 })}</Box>

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
          </>
        )}
      </Box>
      <Footer />
      </Box>
    </SimpleBar>
  );
}
