import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, TextField, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import SimpleBar from "simplebar-react";
import Footer from "../utils/Footer";
import {
  authenticateAdmin,
  consumePendingAdminPassword,
  clearAdminToken,
  getAdminVods,
  getAdminToken,
  isLocalAdminConsole,
  connectAdmin,
  getLocalAdminUrl,
  primeAdminWake,
  republishVodPart,
  republishVod,
  setVodFlags,
  unpublishVodPart,
  unpublishVod,
  verifyAdminSession,
} from "../api/adminApi";

const SORT_DESC = (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
const normalizePartNumber = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
};

export default function AdminPage() {
  const [ready, setReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("all");
  const [vods, setVods] = useState([]);
  const [selectedVodId, setSelectedVodId] = useState("");
  const [selectedVodPartId, setSelectedVodPartId] = useState("");
  const [noticeEnabled, setNoticeEnabled] = useState(false);
  const [chatReplayAvailable, setChatReplayAvailable] = useState(true);
  const [message, setMessage] = useState({ type: "info", text: "Admin panel is locked." });
  const userUnlockInProgressRef = useRef(false);

  const selectedVod = useMemo(() => {
    if (!selectedVodId) return null;
    return vods.find((vod) => String(vod.id) === String(selectedVodId)) || null;
  }, [selectedVodId, vods]);

  const selectedVodParts = useMemo(() => {
    if (!selectedVod || !Array.isArray(selectedVod.youtube)) return [];
    return selectedVod.youtube
      .filter((entry) => String(entry?.type || "vod") === "vod" && entry?.id)
      .map((entry, index) => ({
        ...entry,
        backendOrder: normalizePartNumber(entry?.adminOrder, index + 1),
        storedPartNumber: normalizePartNumber(entry?.part, index + 1),
        isUnpublished: entry?.unpublished === true,
      }))
      .sort((a, b) => {
        if (a.backendOrder !== b.backendOrder) return a.backendOrder - b.backendOrder;
        return String(a.id).localeCompare(String(b.id));
      })
      .map((entry, index, list) => {
        const publishedPartNumber =
          entry.isUnpublished === true ? null : list.slice(0, index + 1).filter((part) => part.isUnpublished !== true).length;
        return {
          ...entry,
          partNumber: publishedPartNumber,
        };
      });
  }, [selectedVod]);

  const selectedVodPart = useMemo(() => {
    if (!selectedVodPartId) return null;
    return selectedVodParts.find((entry) => String(entry.id) === String(selectedVodPartId)) || null;
  }, [selectedVodPartId, selectedVodParts]);

  const publishedSelectedVodPartCount = useMemo(
    () => selectedVodParts.filter((part) => part.isUnpublished !== true).length,
    [selectedVodParts]
  );

  const syncFlagsFromVod = (vod) => {
    if (!vod) return;
    setNoticeEnabled(Boolean(vod.vodNotice));
    setChatReplayAvailable(vod.chatReplayAvailable !== false);
  };

  const hydrateVods = useCallback(async () => {
    const payload = await getAdminVods();
    const nextVods = Array.isArray(payload?.vods) ? [...payload.vods].sort(SORT_DESC) : [];
    setVods(nextVods);

    setSelectedVodId((current) => nextVods.some((vod) => String(vod.id) === String(current)) ? current : String(nextVods[0]?.id || ""));
  }, []);

  const visibleVods = useMemo(() => {
    const term = search.trim().toLowerCase();
    return vods.filter((vod) => (visibility === "all" || (visibility === "hidden") === Boolean(vod.unpublished))
      && (!term || `${vod.title} ${vod.id}`.toLowerCase().includes(term)));
  }, [vods, search, visibility]);
  const flagsChanged = selectedVod && (noticeEnabled !== Boolean(selectedVod.vodNotice) || chatReplayAvailable !== (selectedVod.chatReplayAvailable !== false));

  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const pendingPassword = consumePendingAdminPassword();
        const existingToken = getAdminToken();
        let isAuthorized = false;

        if (pendingPassword) {
          try {
            await authenticateAdmin(pendingPassword);
            isAuthorized = true;
          } catch (error) {
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "error", text: error.message });
          }
        } else if (existingToken) {
          const valid = await verifyAdminSession();
          isAuthorized = valid;
        }

        if (userUnlockInProgressRef.current || !active) return;

        setAuthorized(isAuthorized);
        if (isAuthorized) {
          try {
            await hydrateVods();
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "success", text: "Admin panel unlocked." });
          } catch (error) {
            if (!active || userUnlockInProgressRef.current) return;
            setMessage({ type: "error", text: error.message });
          }
        }
      } catch (error) {
        if (!active || userUnlockInProgressRef.current) return;
        setAuthorized(false);
        setMessage({ type: "error", text: error.message });
      } finally {
        if (!active) return;
        setReady(true);
      }
    };
    init();
    return () => {
      active = false;
    };
  }, [hydrateVods]);

  useEffect(() => {
    syncFlagsFromVod(selectedVod);
  }, [selectedVodId, selectedVod]);

  useEffect(() => {
    if (selectedVodParts.length === 0) {
      setSelectedVodPartId("");
      return;
    }
    const hasCurrent = selectedVodParts.some((entry) => String(entry.id) === String(selectedVodPartId));
    if (!hasCurrent) {
      setSelectedVodPartId(String(selectedVodParts[0].id));
    }
  }, [selectedVodPartId, selectedVodParts]);

  const handleUnlock = async (event) => {
    event?.preventDefault();
    if (!password.trim()) return;
    userUnlockInProgressRef.current = true;
    setLoading(true);
    try {
      await authenticateAdmin(password);
      setPassword("");
      setAuthorized(true);
      await hydrateVods();
      setMessage({ type: "success", text: "Admin panel unlocked." });
    } catch (error) {
      setAuthorized(false);
      setMessage({ type: "error", text: error.message });
    } finally {
      userUnlockInProgressRef.current = false;
      setLoading(false);
      setReady(true);
    }
  };

  const handleLock = () => {
    clearAdminToken();
    setAuthorized(false);
    setMessage({ type: "info", text: "Admin panel locked." });
  };

  const handleRefresh = async () => {
    if (flagsChanged && !window.confirm("Discard unsaved replay settings and refresh?")) return;
    setLoading(true);
    try {
      await hydrateVods();
      setMessage({ type: "success", text: "VOD data refreshed." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveFlags = async () => {
    if (!selectedVod) return;

    setLoading(true);
    try {
      await setVodFlags(selectedVod.id, { noticeEnabled, chatReplayAvailable });
      await hydrateVods();
      setMessage({ type: "success", text: `Updated VOD ${selectedVod.id}.` });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleUnpublish = async () => {
    if (!selectedVod) return;

    const accepted = window.confirm(
      `Unpublish VOD ${selectedVod.id} on YouTube and archive?\n\nTwitch VOD will be kept (no delete).`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await unpublishVod(selectedVod.id);
      await hydrateVods();
      const youtubeCount = Array.isArray(payload?.result?.youtube) ? payload.result.youtube.length : 0;
      const twitchReason = payload?.result?.twitch?.reason ? ` ${payload.result.twitch.reason}` : "";
      setMessage({
        type: "success",
        text: `Unpublished ${selectedVod.id}. YouTube parts affected: ${youtubeCount}.${twitchReason}`,
      });
    } catch (error) {
      if (error?.code === "TWITCH_AUTH_REQUIRED" && error?.authUrl) {
        try {
          window.open(error.authUrl, "_blank", "noopener,noreferrer");
        } catch {
          // no-op
        }
        const codeHint = error?.userCode ? ` Use code ${error.userCode} if prompted.` : "";
        setMessage({
          type: "warning",
          text: `Twitch authorization is required.${codeHint} If no browser tab opened, open this URL manually: ${error.authUrl}`,
        });
        return;
      }
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleUnpublishPart = async () => {
    if (!selectedVod || !selectedVodPart) return;
    if (selectedVodPart.isUnpublished) {
      setMessage({ type: "warning", text: "Selected part is already unpublished. Use Republish Selected Part." });
      return;
    }
    if (publishedSelectedVodPartCount <= 1) {
      setMessage({ type: "warning", text: "This VOD only has one part. You cannot unpublish a single part." });
      return;
    }
    const publishedPartNumber = selectedVodPart.partNumber;
    if (!publishedPartNumber) {
      setMessage({ type: "error", text: "Could not resolve the current published part number." });
      return;
    }

    const accepted = window.confirm(
      `Unpublish VOD ${selectedVod.id} part ${publishedPartNumber} (${selectedVodPart.id}) on YouTube and hide it from the VOD site?\n\nRemaining published parts will be renumbered to stay contiguous.`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await unpublishVodPart(selectedVod.id, publishedPartNumber);
      await hydrateVods();
      const remainingCount = Array.isArray(payload?.result?.remainingParts) ? payload.result.remainingParts.length : 0;
      setMessage({
        type: "success",
        text: `Unpublished VOD ${selectedVod.id} part ${publishedPartNumber} on YouTube and VOD site. Remaining published parts: ${remainingCount}.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRepublishPart = async () => {
    if (!selectedVod || !selectedVodPart) return;
    if (!selectedVodPart.isUnpublished) {
      setMessage({ type: "warning", text: "Selected part is already published." });
      return;
    }

    const accepted = window.confirm(
      `Republish VOD ${selectedVod.id} part ${selectedVodPart.id} on YouTube and restore it on the VOD site?`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await republishVodPart(selectedVod.id, selectedVodPart.id);
      await hydrateVods();
      const republishedPartNumber = payload?.result?.republishedPart ? ` as part ${payload.result.republishedPart}` : "";
      setMessage({
        type: "success",
        text: `Republished part ${selectedVodPart.id}${republishedPartNumber} on YouTube and VOD site.`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRepublish = async () => {
    if (!selectedVod) return;

    const accepted = window.confirm(
      `Republish VOD ${selectedVod.id} on YouTube and make it visible on the archive site?`
    );
    if (!accepted) return;

    setLoading(true);
    try {
      const payload = await republishVod(selectedVod.id);
      await hydrateVods();
      const youtubeResults = Array.isArray(payload?.result?.youtube) ? payload.result.youtube : [];
      const youtubeChanged = youtubeResults.filter((entry) => entry?.changed).length;
      const twitchReason = payload?.result?.twitch?.reason ? ` Twitch: ${payload.result.twitch.reason}` : "";
      const twitchRepublished = payload?.result?.twitch?.republished !== false;
      setMessage({
        type: twitchRepublished ? "success" : "warning",
        text: `Republished ${selectedVod.id}. YouTube parts changed: ${youtubeChanged}/${youtubeResults.length}.${twitchReason}`,
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };


  if (!ready) return <Box sx={{ display: "grid", placeItems: "center", height: "100%" }}><CircularProgress size={28} aria-label="Connecting to admin" /></Box>;

  const panel = { border: "1px solid var(--soft-border)", borderRadius: "16px", background: "var(--soft-surface)", p: { xs: 2, md: 3 }, minWidth: 0 };
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Undated" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  return (
    <SimpleBar style={{ minHeight: 0, height: "100%" }}>
      <Box component="main" sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1180, mx: "auto" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" useFlexGap flexWrap="wrap" gap={2} sx={{ mb: 3 }}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 600, letterSpacing: "-0.04em" }}>Archive admin</Typography>
            <Typography variant="body2" color="text.secondary">Manage your VODs and site.</Typography>
          </Box>
          <Stack direction="row" useFlexGap flexWrap="wrap" gap={1}>
            {authorized && <>
              <Button variant="outlined" onClick={handleRefresh} disabled={loading}>Refresh</Button>
              <Button component={RouterLink} to="/admin/design" variant="contained" disabled={loading}>Edit site</Button>
              <Button onClick={handleLock} disabled={loading}>Sign out</Button>
            </>}
          </Stack>
        </Stack>

        {(message.type !== "info" || authorized) && <Alert severity={message.type} sx={{ mb: 2 }} aria-live="polite">{message.text}</Alert>}

        {!authorized ? (
          <Box sx={{ ...panel, maxWidth: 460, mx: "auto", my: { xs: 2, md: 6 } }}>
            <Typography component="h2" variant="h6" sx={{ mb: 1 }}>Welcome back</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {isLocalAdminConsole ? "Your archive is connected on this PC. Sign in to make changes." : "Open Softuchive and choose Open admin for a direct connection to this PC."}
            </Typography>
            <Box component="form" onSubmit={handleUnlock}>
              <TextField fullWidth autoFocus type="password" label="Admin password" autoComplete="current-password"
                value={password} onChange={(event) => setPassword(event.target.value)} disabled={loading} sx={{ mb: 2 }} />
              <Button fullWidth type="submit" variant="contained" disabled={loading || !password.trim()}>
                {loading ? "Connecting…" : "Sign in"}
              </Button>
            </Box>
            {!isLocalAdminConsole && <Stack direction="row" useFlexGap flexWrap="wrap" gap={1} sx={{ mt: 2 }}>
              <Button size="small" onClick={primeAdminWake} disabled={loading}>Start local bridge</Button>
              <Button size="small" onClick={async () => {
                setLoading(true);
                try { await connectAdmin(); window.location.assign(getLocalAdminUrl()); }
                catch (error) { setMessage({ type: "error", text: error.message }); }
                finally { setLoading(false); }
              }} disabled={loading}>Open local admin</Button>
            </Stack>}
          </Box>
        ) : (
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "320px minmax(0, 1fr)" }, gap: 3, alignItems: "start" }}>
            <Box component="aside" aria-label="Choose a VOD" sx={panel}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                <Typography component="h2" variant="h6">VODs</Typography>
                <Typography variant="caption" color="text.secondary">{vods.length} total</Typography>
              </Stack>
              <TextField fullWidth size="small" label="Search title or ID" value={search} onChange={(event) => setSearch(event.target.value)} sx={{ mb: 1.5 }} />
              <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                <InputLabel id="visibility-filter">Visibility</InputLabel>
                <Select labelId="visibility-filter" label="Visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
                  <MenuItem value="all">All VODs</MenuItem><MenuItem value="published">Published</MenuItem><MenuItem value="hidden">Unpublished</MenuItem>
                </Select>
              </FormControl>
              <Box sx={{ maxHeight: { xs: 240, md: "62vh" }, overflowY: "auto", mx: -1, px: 1 }}>
                {visibleVods.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>No VODs found.</Typography>}
                {visibleVods.map((vod) => <Box component="button" type="button" key={vod.id} disabled={loading}
                  onClick={() => {
                    if (flagsChanged && !window.confirm("Discard the unsaved changes to this VOD?")) return;
                    setSelectedVodId(String(vod.id));
                  }}
                  aria-pressed={String(vod.id) === String(selectedVodId)}
                  sx={{ width: "100%", display: "block", textAlign: "left", p: 1.5, mb: .5, borderRadius: "10px", border: "1px solid",
                    borderColor: String(vod.id) === String(selectedVodId) ? "var(--soft-text)" : "transparent",
                    background: String(vod.id) === String(selectedVodId) ? "var(--soft-surface-strong)" : "transparent",
                    color: "inherit", font: "inherit", cursor: "pointer", transition: "background-color 140ms ease",
                    "&:hover": { background: "var(--soft-surface-strong)" }, "&:focus-visible": { outline: "2px solid var(--soft-text)", outlineOffset: 2 } }}>
                  <Typography component="span" variant="body2" sx={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{vod.title || "Untitled VOD"}</Typography>
                  <Typography component="span" variant="caption" color="text.secondary">{formatDate(vod.createdAt)}{vod.unpublished ? " · Unpublished" : ""}</Typography>
                </Box>)}
              </Box>
            </Box>
            {selectedVod ? <Stack spacing={2.5} sx={{ minWidth: 0 }} aria-busy={loading}>
              <Box sx={panel}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2} sx={{ mb: 1 }}>
                  <Chip size="small" variant="outlined" label={selectedVod.unpublished ? "Unpublished" : "Published"} />
                  {!selectedVod.unpublished && <Button component={RouterLink} to={`/${selectedVod.id}`} size="small">View VOD ↗</Button>}
                </Stack>
                <Typography component="h2" variant="h5" sx={{ overflowWrap: "anywhere", fontWeight: 600, mt: 2, mb: 1 }}>{selectedVod.title || "Untitled VOD"}</Typography>
                <Typography variant="body2" color="text.secondary">{formatDate(selectedVod.createdAt)} · {selectedVodParts.length} {selectedVodParts.length === 1 ? "part" : "parts"} · {selectedVod.id}</Typography>
                <Divider sx={{ my: 2.5 }} />
                <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>Replay settings</Typography>
                <Stack>
                  <FormControlLabel control={<Switch disabled={loading} checked={chatReplayAvailable} onChange={(event) => setChatReplayAvailable(event.target.checked)} />} label="Chat replay" />
                  <FormControlLabel control={<Switch disabled={loading} checked={noticeEnabled} onChange={(event) => setNoticeEnabled(event.target.checked)} />} label="Spotify muted notice" />
                </Stack>
                <Stack direction="row" alignItems="center" gap={2} sx={{ mt: 2 }}>
                  <Button variant="contained" onClick={handleSaveFlags} disabled={loading || !flagsChanged}>{loading ? "Working…" : "Save changes"}</Button>
                  {flagsChanged && <Typography variant="caption" color="text.secondary">Unsaved changes</Typography>}
                </Stack>
              </Box>
              <Box sx={panel}>
                <Typography component="h3" variant="h6" sx={{ mb: 1 }}>Publication</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Manage availability on YouTube and the archive. Your Twitch VOD is kept.</Typography>
                <Stack direction="row" useFlexGap flexWrap="wrap" gap={1}>
                  {selectedVod.unpublished
                    ? <Button variant="outlined" onClick={handleRepublish} disabled={loading}>Republish VOD</Button>
                    : <Button variant="outlined" color="error" onClick={handleUnpublish} disabled={loading}>Unpublish VOD</Button>}
                </Stack>
                {selectedVodParts.length > 0 && <>
                  <Divider sx={{ my: 2.5 }} />
                  <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                    <InputLabel id="admin-vod-part-label">YouTube part</InputLabel>
                    <Select labelId="admin-vod-part-label" label="YouTube part" value={selectedVodPartId}
                      onChange={(event) => setSelectedVodPartId(event.target.value)} disabled={loading || selectedVod.unpublished}>
                      {selectedVodParts.map((part) => <MenuItem key={part.id} value={String(part.id)}>
                        {part.isUnpublished ? `Unpublished · ${part.id}` : `Part ${part.partNumber} · ${part.id}`}
                      </MenuItem>)}
                    </Select>
                  </FormControl>
                  {selectedVodPart?.isUnpublished
                    ? <Button variant="outlined" onClick={handleRepublishPart} disabled={loading || selectedVod.unpublished}>Republish part</Button>
                    : <Button variant="outlined" color="error" onClick={handleUnpublishPart} disabled={loading || selectedVod.unpublished || !selectedVodPart || publishedSelectedVodPartCount <= 1}>Unpublish part</Button>}
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
                    {publishedSelectedVodPartCount > 1 ? "Remaining parts are renumbered automatically." : "Keep at least one part published, or unpublish the whole VOD."}
                  </Typography>
                </>}
              </Box>
            </Stack> : <Box sx={panel}><Typography color="text.secondary">Your archive is empty. Published uploads will appear here.</Typography></Box>}
          </Box>
        )}
      </Box>
      <Footer />
    </SimpleBar>
  );
}
