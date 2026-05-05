import { useCallback, useEffect, useMemo, useState } from "react";
import { Puck } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import PublishRoundedIcon from "@mui/icons-material/PublishRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import WidgetsRoundedIcon from "@mui/icons-material/WidgetsRounded";
import SimpleBar from "simplebar-react";
import {
  clearAdminToken,
  getAdminToken,
  getSiteDesignAdmin,
  primeAdminWake,
  promptAndLoginAdmin,
  publishSiteDesign,
  verifyAdminSession,
} from "../api/adminApi";
import Footer from "../utils/Footer";
import Loading from "../utils/Loading";
import { useSiteDesign } from "./DesignContext";
import { designConfig } from "./designConfig";
import { createBlankPuckData, createPage, normalizeSiteDesign, slugifyPagePath } from "./defaultDesign";

const ICON_OPTIONS = [
  { label: "Home", value: "home" },
  { label: "VODs", value: "vods" },
  { label: "Page", value: "page" },
  { label: "Image", value: "image" },
  { label: "Link", value: "link" },
  { label: "Music", value: "music" },
  { label: "Star", value: "star" },
  { label: "Heart", value: "heart" },
];

const clone = (value) => JSON.parse(JSON.stringify(value));

const getMaxNavOrder = (pages) => Math.max(0, ...pages.map((page) => Number(page.navOrder) || 0));

const makeUniquePath = (path, pages, currentPageId = "") => {
  const base = slugifyPagePath(path);
  if (base === "/") return "/";
  const used = new Set(
    pages
      .filter((page) => page.id !== currentPageId)
      .map((page) => page.path)
  );
  if (!used.has(base)) return base;

  let index = 2;
  let nextPath = `${base}-${index}`;
  while (used.has(nextPath)) {
    index += 1;
    nextPath = `${base}-${index}`;
  }
  return nextPath;
};

const updatePageById = (design, pageId, updater) =>
  normalizeSiteDesign({
    ...design,
    pages: design.pages.map((page) => (page.id === pageId ? updater(page) : page)),
  });

export default function DesignEditorPage() {
  const { design, setDesign } = useSiteDesign();
  const [ready, setReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftDesign, setDraftDesign] = useState(() => normalizeSiteDesign(design));
  const [selectedPageId, setSelectedPageId] = useState("home");
  const [editorRevision, setEditorRevision] = useState(0);
  const [componentsPanelOpen, setComponentsPanelOpen] = useState(true);
  const [fieldsPanelOpen, setFieldsPanelOpen] = useState(true);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [message, setMessage] = useState({ type: "info", text: "Unlock admin to edit the live site design." });

  useEffect(() => {
    setDraftDesign(normalizeSiteDesign(design));
  }, [design]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const hasToken = Boolean(getAdminToken());
        const valid = hasToken ? await verifyAdminSession() : false;
        if (!active) return;
        setAuthorized(valid);
        setMessage(valid ? { type: "success", text: "Design editor unlocked." } : { type: "info", text: "Unlock admin to edit the live site design." });
      } finally {
        if (active) setReady(true);
      }
    };
    init();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authorized) return undefined;

    let disposed = false;
    const keepAlive = async () => {
      try {
        const valid = await verifyAdminSession();
        if (disposed) return;
        if (!valid) {
          setAuthorized(false);
          setMessage({ type: "warning", text: "Admin session expired. Unlock again before publishing." });
        }
      } catch {
        if (!disposed) {
          setMessage({ type: "warning", text: "Admin bridge is not responding. Keep editing, then unlock again before publishing if needed." });
        }
      }
    };

    const intervalId = window.setInterval(keepAlive, 2 * 60 * 1000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void keepAlive();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [authorized]);

  const selectedPage = useMemo(
    () => draftDesign.pages.find((page) => page.id === selectedPageId) || draftDesign.pages[0] || null,
    [draftDesign.pages, selectedPageId]
  );

  const editablePuckData = selectedPage?.type === "puck" ? selectedPage.puck || createBlankPuckData(selectedPage.title) : null;

  const patchSelectedPage = useCallback(
    (updater) => {
      if (!selectedPage) return;
      setDraftDesign((current) => updatePageById(current, selectedPage.id, updater));
    },
    [selectedPage]
  );

  const handleUnlock = async () => {
    setSaving(true);
    try {
      const didLogin = await promptAndLoginAdmin();
      if (!didLogin) {
        setMessage({ type: "info", text: "Admin login canceled." });
        return;
      }
      setAuthorized(true);
      const payload = await getSiteDesignAdmin().catch(() => null);
      if (payload?.design) {
        const nextDesign = normalizeSiteDesign(payload.design);
        setDraftDesign(nextDesign);
        setDesign(nextDesign);
      }
      setMessage({ type: "success", text: "Design editor unlocked." });
    } catch (error) {
      setAuthorized(false);
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
      setReady(true);
    }
  };

  const handleLock = () => {
    clearAdminToken();
    setAuthorized(false);
    setMessage({ type: "info", text: "Design editor locked." });
  };

  const handleRefreshFromDisk = async () => {
    setSaving(true);
    try {
      const payload = await getSiteDesignAdmin();
      const nextDesign = normalizeSiteDesign(payload.design);
      setDraftDesign(nextDesign);
      setDesign(nextDesign);
      setSelectedPageId(nextDesign.pages[0]?.id || "home");
      setEditorRevision((value) => value + 1);
      setMessage({ type: "success", text: "Loaded design data from the local admin bridge." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const publishDesign = async (pageDataFromPuck = null) => {
    if (!authorized) {
      setMessage({ type: "warning", text: "Unlock admin before publishing." });
      return;
    }

    setSaving(true);
    try {
      const nextDesign = normalizeSiteDesign({
        ...draftDesign,
        pages: draftDesign.pages.map((page) =>
          page.id === selectedPage?.id && page.type === "puck"
            ? {
                ...page,
                puck: pageDataFromPuck || page.puck || createBlankPuckData(page.title),
              }
            : page
        ),
      });
      const payload = await publishSiteDesign(nextDesign);
      const publishedDesign = normalizeSiteDesign(payload.design || nextDesign);
      setDraftDesign(publishedDesign);
      setDesign(publishedDesign);
      setMessage({
        type: "success",
        text: "Published design data. The existing GitHub Pages workflow will redeploy after the push to main.",
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handlePuckChange = (data) => {
    if (!selectedPage || selectedPage.type !== "puck") return;
    setDraftDesign((current) =>
      updatePageById(current, selectedPage.id, (page) => ({
        ...page,
        puck: data,
      }))
    );
  };

  const handleAddPage = () => {
    const title = window.prompt("New page title", "New Page");
    if (title == null) return;
    const cleanTitle = String(title).trim() || "New Page";
    setDraftDesign((current) => {
      const nextPage = createPage({
        title: cleanTitle,
        path: makeUniquePath(cleanTitle, current.pages),
        navOrder: getMaxNavOrder(current.pages) + 10,
      });
      setSelectedPageId(nextPage.id);
      setEditorRevision((value) => value + 1);
      return normalizeSiteDesign({
        ...current,
        pages: [...current.pages, nextPage],
      });
    });
  };

  const handleDuplicatePage = () => {
    if (!selectedPage || selectedPage.type !== "puck") return;
    setDraftDesign((current) => {
      const copyTitle = `${selectedPage.title} Copy`;
      const nextPage = {
        ...clone(selectedPage),
        id: `page-${Date.now().toString(36)}`,
        title: copyTitle,
        navLabel: copyTitle,
        path: makeUniquePath(copyTitle, current.pages),
        navOrder: getMaxNavOrder(current.pages) + 10,
      };
      setSelectedPageId(nextPage.id);
      setEditorRevision((value) => value + 1);
      return normalizeSiteDesign({
        ...current,
        pages: [...current.pages, nextPage],
      });
    });
  };

  const handleDeletePage = () => {
    if (!selectedPage || selectedPage.id === "home" || selectedPage.id === "vods") return;
    const accepted = window.confirm(`Delete page "${selectedPage.title}" from the design data?`);
    if (!accepted) return;
    setDraftDesign((current) => {
      const nextPages = current.pages.filter((page) => page.id !== selectedPage.id);
      setSelectedPageId(nextPages[0]?.id || "home");
      setEditorRevision((value) => value + 1);
      return normalizeSiteDesign({ ...current, pages: nextPages });
    });
  };

  const handlePageField = (field, value) => {
    patchSelectedPage((page) => {
      const next = { ...page, [field]: value };
      if (field === "title" && !page.navLabel) next.navLabel = value;
      if (field === "path") {
        next.path = page.id === "home" ? "/" : makeUniquePath(value, draftDesign.pages, page.id);
      }
      return next;
    });
  };

  const handleSettingsField = (field, value) => {
    setDraftDesign((current) => {
      const nextDesign = normalizeSiteDesign({
        ...current,
        settings: {
          ...current.settings,
          [field]: value,
        },
      });
      setDesign(nextDesign);
      return nextDesign;
    });
  };

  if (!ready) return <Loading />;

  const pageSettingsPanel = (
    <Box
      className="soft-design-editor-settings soft-glass"
      sx={{
        position: "absolute",
        top: 62,
        left: { xs: 8, md: 12 },
        right: { xs: 8, md: 12 },
        zIndex: 12,
        borderRadius: "20px",
        overflow: "hidden",
      }}
    >
      <SimpleBar style={{ maxHeight: "min(58vh, 540px)" }}>
        <Box sx={{ p: { xs: 1, md: 1.25 }, display: "grid", gap: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="h6" sx={{ color: "primary.main", lineHeight: 1 }}>
                Page Settings
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                Page metadata, header navigation, and publish controls.
              </Typography>
            </Box>
            <IconButton onClick={() => setPageSettingsOpen(false)} aria-label="Close page settings">
              <CloseRoundedIcon />
            </IconButton>
          </Stack>

          <Alert severity={message.type}>{message.text}</Alert>

          <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "stretch", md: "center" }}>
            <Select
              size="small"
              value={selectedPage?.id || ""}
              onChange={(event) => {
                setSelectedPageId(event.target.value);
                setEditorRevision((value) => value + 1);
              }}
              sx={{ minWidth: { xs: "100%", md: 220 } }}
            >
              {draftDesign.pages.map((page) => (
                <MenuItem key={page.id} value={page.id}>
                  {page.navLabel || page.title} {page.type === "system" ? "(system)" : ""}
                </MenuItem>
              ))}
            </Select>
            <Button startIcon={<AddRoundedIcon />} onClick={handleAddPage} disabled={!authorized || saving}>
              Add Page
            </Button>
            <Button startIcon={<ContentCopyRoundedIcon />} onClick={handleDuplicatePage} disabled={!authorized || saving || selectedPage?.type !== "puck"}>
              Duplicate
            </Button>
            <Button
              startIcon={<DeleteRoundedIcon />}
              color="error"
              onClick={handleDeletePage}
              disabled={!authorized || saving || !selectedPage || selectedPage.id === "home" || selectedPage.id === "vods"}
            >
              Delete
            </Button>
          </Stack>

          <Divider />

          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(6, minmax(0, 1fr))" }, gap: 1 }}>
            <TextField
              size="small"
              label="Page title"
              value={selectedPage?.title || ""}
              onChange={(event) => handlePageField("title", event.target.value)}
              disabled={!authorized || !selectedPage}
              sx={{ gridColumn: { md: "span 2" } }}
            />
            <TextField
              size="small"
              label="Nav label"
              value={selectedPage?.navLabel || ""}
              onChange={(event) => handlePageField("navLabel", event.target.value)}
              disabled={!authorized || !selectedPage}
              sx={{ gridColumn: { md: "span 1" } }}
            />
            <TextField
              size="small"
              label="Path"
              value={selectedPage?.path || ""}
              onChange={(event) => handlePageField("path", event.target.value)}
              disabled={!authorized || !selectedPage || selectedPage.id === "home" || selectedPage.type === "system"}
              sx={{ gridColumn: { md: "span 1" } }}
            />
            <Select
              size="small"
              value={selectedPage?.icon || "page"}
              onChange={(event) => handlePageField("icon", event.target.value)}
              disabled={!authorized || !selectedPage}
              sx={{ gridColumn: { md: "span 1" } }}
            >
              {ICON_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
            <FormControlLabel
              control={
                <Switch
                  checked={selectedPage?.navVisible !== false}
                  onChange={(event) => handlePageField("navVisible", event.target.checked)}
                  disabled={!authorized || !selectedPage}
                />
              }
              label="Show in header"
              sx={{ gridColumn: { md: "span 1" }, mx: 0 }}
            />
          </Box>

          <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 0.5 }}>
            Header
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(6, minmax(0, 1fr))" }, gap: 1 }}>
            <TextField
              size="small"
              label="Header title"
              value={draftDesign.settings.headerBrandText || ""}
              onChange={(event) => handleSettingsField("headerBrandText", event.target.value)}
              disabled={!authorized}
              sx={{ gridColumn: { md: "span 2" } }}
            />
            <TextField
              size="small"
              label="Header tagline"
              value={draftDesign.settings.headerTagline || ""}
              onChange={(event) => handleSettingsField("headerTagline", event.target.value)}
              disabled={!authorized}
              sx={{ gridColumn: { md: "span 2" } }}
            />
            <Select
              size="small"
              value={draftDesign.settings.navStyle || "pill"}
              onChange={(event) => handleSettingsField("navStyle", event.target.value)}
              disabled={!authorized}
            >
              <MenuItem value="pill">Pill nav</MenuItem>
              <MenuItem value="plain">Plain nav</MenuItem>
            </Select>
            <Select
              size="small"
              value={draftDesign.settings.headerSurface || "glass"}
              onChange={(event) => handleSettingsField("headerSurface", event.target.value)}
              disabled={!authorized}
            >
              <MenuItem value="glass">Glass header</MenuItem>
              <MenuItem value="solid">Solid header</MenuItem>
              <MenuItem value="transparent">Transparent header</MenuItem>
            </Select>
            <TextField
              size="small"
              label="Logo URL"
              value={draftDesign.settings.headerLogoUrl || ""}
              onChange={(event) => handleSettingsField("headerLogoUrl", event.target.value)}
              disabled={!authorized}
              sx={{ gridColumn: { md: "span 2" } }}
            />
            <TextField
              size="small"
              label="Logo size"
              type="number"
              value={draftDesign.settings.headerLogoSize || 52}
              onChange={(event) => handleSettingsField("headerLogoSize", Number(event.target.value))}
              disabled={!authorized}
            />
            <TextField
              size="small"
              label="Header roundness"
              type="number"
              value={draftDesign.settings.headerRadius || 20}
              onChange={(event) => handleSettingsField("headerRadius", Number(event.target.value))}
              disabled={!authorized}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draftDesign.settings.showHeaderLogo !== false}
                  onChange={(event) => handleSettingsField("showHeaderLogo", event.target.checked)}
                  disabled={!authorized}
                />
              }
              label="Logo"
              sx={{ mx: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draftDesign.settings.showHeaderTitle !== false}
                  onChange={(event) => handleSettingsField("showHeaderTitle", event.target.checked)}
                  disabled={!authorized}
                />
              }
              label="Title"
              sx={{ mx: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draftDesign.settings.showSocials !== false}
                  onChange={(event) => handleSettingsField("showSocials", event.target.checked)}
                  disabled={!authorized}
                />
              }
              label="Show socials in header"
              sx={{ mx: 0 }}
            />
          </Box>

          <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 0.5 }}>
            Footer
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(6, minmax(0, 1fr))" }, gap: 1 }}>
            <TextField
              size="small"
              label="Footer text"
              value={draftDesign.settings.footerText || ""}
              onChange={(event) => handleSettingsField("footerText", event.target.value)}
              disabled={!authorized}
              sx={{ gridColumn: { md: "span 2" } }}
            />
            <Select
              size="small"
              value={draftDesign.settings.footerSurface || "glass"}
              onChange={(event) => handleSettingsField("footerSurface", event.target.value)}
              disabled={!authorized}
            >
              <MenuItem value="glass">Glass footer</MenuItem>
              <MenuItem value="solid">Solid footer</MenuItem>
              <MenuItem value="transparent">Transparent footer</MenuItem>
            </Select>
            <TextField
              size="small"
              label="Footer roundness"
              type="number"
              value={draftDesign.settings.footerRadius || 20}
              onChange={(event) => handleSettingsField("footerRadius", Number(event.target.value))}
              disabled={!authorized}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draftDesign.settings.footerEnabled !== false}
                  onChange={(event) => handleSettingsField("footerEnabled", event.target.checked)}
                  disabled={!authorized}
                />
              }
              label="Show footer"
              sx={{ mx: 0 }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draftDesign.settings.footerShowBuild !== false}
                  onChange={(event) => handleSettingsField("footerShowBuild", event.target.checked)}
                  disabled={!authorized}
                />
              }
              label="Build hash"
              sx={{ mx: 0 }}
            />
            {[1, 2, 3].map((index) => (
              <Box key={index} sx={{ display: "contents" }}>
                <TextField
                  size="small"
                  label={`Footer link ${index} label`}
                  value={draftDesign.settings[`footerLink${index}Label`] || ""}
                  onChange={(event) => handleSettingsField(`footerLink${index}Label`, event.target.value)}
                  disabled={!authorized}
                  sx={{ gridColumn: { md: "span 2" } }}
                />
                <TextField
                  size="small"
                  label={`Footer link ${index} URL`}
                  value={draftDesign.settings[`footerLink${index}Href`] || ""}
                  onChange={(event) => handleSettingsField(`footerLink${index}Href`, event.target.value)}
                  disabled={!authorized}
                  sx={{ gridColumn: { md: "span 4" } }}
                />
              </Box>
            ))}
          </Box>
        </Box>
      </SimpleBar>
    </Box>
  );

  const editorTopbar = (
    <Box
      className="soft-design-editor-topbar"
      sx={{
        position: "relative",
        zIndex: 14,
        minHeight: 56,
        px: { xs: 1, md: 1.25 },
        py: 0.75,
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        borderBottom: "1px solid var(--soft-border)",
        background: "var(--soft-surface-strong)",
        backdropFilter: "blur(16px) saturate(140%)",
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flex: "1 1 320px" }}>
        <Tooltip title={componentsPanelOpen ? "Hide blocks panel" : "Show blocks panel"}>
          <IconButton onClick={() => setComponentsPanelOpen((value) => !value)} color={componentsPanelOpen ? "secondary" : "primary"} aria-label="Toggle blocks panel">
            <WidgetsRoundedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={fieldsPanelOpen ? "Hide settings panel" : "Show settings panel"}>
          <IconButton onClick={() => setFieldsPanelOpen((value) => !value)} color={fieldsPanelOpen ? "secondary" : "primary"} aria-label="Toggle settings panel">
            <TuneRoundedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Page settings">
          <IconButton onClick={() => setPageSettingsOpen((value) => !value)} color={pageSettingsOpen ? "secondary" : "primary"} aria-label="Toggle page settings">
            <SettingsRoundedIcon />
          </IconButton>
        </Tooltip>
        <Select
          size="small"
          value={selectedPage?.id || ""}
          onChange={(event) => {
            setSelectedPageId(event.target.value);
            setEditorRevision((value) => value + 1);
          }}
          sx={{ minWidth: 180, maxWidth: { xs: 210, md: 280 } }}
        >
          {draftDesign.pages.map((page) => (
            <MenuItem key={page.id} value={page.id}>
              {page.navLabel || page.title} {page.type === "system" ? "(system)" : ""}
            </MenuItem>
          ))}
        </Select>
        <Box sx={{ minWidth: 0, display: { xs: "none", lg: "block" } }}>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {selectedPage?.path || "/"} · {message.text}
          </Typography>
        </Box>
      </Stack>

      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: "wrap", gap: 0.75 }}>
        {!authorized ? (
          <Button variant="contained" onMouseDown={primeAdminWake} onTouchStart={primeAdminWake} onClick={handleUnlock} disabled={saving}>
            Unlock Admin
          </Button>
        ) : (
          <>
            <Button variant="outlined" onClick={handleRefreshFromDisk} disabled={saving}>
              Reload
            </Button>
            <Button variant="contained" startIcon={<PublishRoundedIcon />} onClick={() => publishDesign()} disabled={saving}>
              Publish
            </Button>
            <Button variant="outlined" color="warning" onClick={handleLock} disabled={saving}>
              Lock
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ minHeight: 0, height: "100%", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      {editorTopbar}
      {pageSettingsOpen && pageSettingsPanel}

      <Box sx={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        {!selectedPage ? (
          <Loading />
        ) : selectedPage.type !== "puck" ? (
          <Box className="soft-design-editor-preview-scroll" sx={{ height: "100%", overflowY: "auto", p: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>
              This is a system page. Its header label, icon, and visibility are editable here, while the archive layout stays in code so the VOD tools keep working.
            </Alert>
            <Footer />
          </Box>
        ) : (
          <Puck
            key={`${selectedPage.id}-${editorRevision}`}
            config={designConfig}
            data={editablePuckData}
            onChange={handlePuckChange}
            onPublish={publishDesign}
            headerTitle={`Editing ${selectedPage.title}`}
            headerPath={selectedPage.path}
            height="100%"
            iframe={{ enabled: false }}
          >
            <Box className="soft-design-editor-puck-shell">
              <Box className={`soft-design-editor-panel soft-design-editor-panel--left${componentsPanelOpen ? " is-open" : ""}`}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.1, py: 0.8, borderBottom: "1px solid var(--soft-border)" }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                    Blocks
                  </Typography>
                  <IconButton size="small" onClick={() => setComponentsPanelOpen(false)} aria-label="Hide blocks panel">
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </Stack>
                <SimpleBar style={{ height: "calc(100% - 48px)" }}>
                  <Box sx={{ p: 1 }}>
                    <Puck.Components />
                    <Divider sx={{ my: 1.2 }} />
                    <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 0.7 }}>
                      Outline
                    </Typography>
                    <Puck.Outline />
                  </Box>
                </SimpleBar>
              </Box>

              <Box className="soft-design-editor-preview-scroll">
                <Box className="soft-design-editor-preview-frame">
                  <Puck.Preview id="soft-design-editor-preview" />
                  <Footer />
                </Box>
              </Box>

              <Box className={`soft-design-editor-panel soft-design-editor-panel--right${fieldsPanelOpen ? " is-open" : ""}`}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.1, py: 0.8, borderBottom: "1px solid var(--soft-border)" }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                    Selected Block
                  </Typography>
                  <IconButton size="small" onClick={() => setFieldsPanelOpen(false)} aria-label="Hide settings panel">
                    <CloseRoundedIcon fontSize="small" />
                  </IconButton>
                </Stack>
                <SimpleBar style={{ height: "calc(100% - 48px)" }}>
                  <Box sx={{ p: 1 }}>
                    <Puck.Fields />
                  </Box>
                </SimpleBar>
              </Box>
            </Box>
          </Puck>
        )}
      </Box>
    </Box>
  );
}
