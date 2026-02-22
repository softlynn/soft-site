(function () {
  "use strict";

  var DEFAULT_SITE_URL = "https://softu.one";
  var DEFAULT_DATA_URL = DEFAULT_SITE_URL + "/data/vods.json";
  var MAX_VODS = 4;

  var appEl = document.getElementById("app");
  var listEl = document.getElementById("vod-list");
  var loadingEl = document.getElementById("loading-state");
  var errorEl = document.getElementById("error-state");
  var archiveLinkEl = document.getElementById("open-archive-link");

  var params = new URLSearchParams(window.location.search || "");
  var siteUrl = normalizeBaseUrl(params.get("siteUrl") || DEFAULT_SITE_URL);
  var dataUrl = params.get("dataUrl") || (siteUrl + "/data/vods.json");

  if (archiveLinkEl) {
    archiveLinkEl.href = siteUrl + "/#/vods";
  }

  // Intentionally default to light mode for this panel to match the site design.
  // The panel edges remain transparent so it blends into Twitch's dark UI.
  document.body.setAttribute("data-theme", "light");

  fetchAndRender();

  function fetchAndRender() {
    setLoading(true);
    setError("");

    fetch(dataUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (payload) {
        var vods = normalizeVods(payload);
        renderVods(vods);
      })
      .catch(function (error) {
        console.error("softu Twitch panel failed to load VODs:", error);
        setError(
          "Could not load recent VODs. Check extension allowlisted domains and that " +
            dataUrl +
            " is reachable."
        );
      })
      .finally(function () {
        setLoading(false);
      });
  }

  function normalizeBaseUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return DEFAULT_SITE_URL;
    return raw.replace(/\/+$/, "");
  }

  function normalizeVods(payload) {
    var list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.data)
      ? payload.data
      : [];

    return list
      .filter(function (vod) {
        return vod && vod.unpublished !== true;
      })
      .filter(function (vod) {
        return Array.isArray(vod.youtube) && vod.youtube.length > 0;
      })
      .sort(function (a, b) {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      })
      .slice(0, MAX_VODS);
  }

  function getVodHref(vod) {
    return siteUrl + "/#/youtube/" + encodeURIComponent(vod.id);
  }

  function getVodThumbnail(vod) {
    if (Array.isArray(vod.youtube) && vod.youtube[0] && vod.youtube[0].thumbnail_url) {
      return vod.youtube[0].thumbnail_url;
    }
    return vod.thumbnail_url || "";
  }

  function formatDate(dateValue) {
    if (!dateValue) return "Unknown date";
    var date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 10);
    }
  }

  function renderVods(vods) {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!vods.length) {
      var empty = document.createElement("div");
      empty.className = "softu-empty";
      empty.textContent = "No published VODs found yet.";
      listEl.appendChild(empty);
      listEl.classList.remove("is-hidden");
      return;
    }

    var fragment = document.createDocumentFragment();

    vods.forEach(function (vod, index) {
      var card = document.createElement("a");
      card.className = "softu-card";
      card.href = getVodHref(vod);
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.setAttribute("aria-label", "Open VOD: " + (vod.title || vod.id));

      var thumb = document.createElement("div");
      thumb.className = "softu-card__thumb";
      var thumbUrl = getVodThumbnail(vod);
      if (thumbUrl) {
        var img = document.createElement("img");
        img.src = thumbUrl;
        img.alt = "";
        img.loading = index === 0 ? "eager" : "lazy";
        img.referrerPolicy = "no-referrer";
        thumb.appendChild(img);
      }

      var meta = document.createElement("div");
      meta.className = "softu-card__meta";

      var title = document.createElement("div");
      title.className = "softu-card__title";
      title.textContent = String(vod.title || vod.id || "Untitled VOD");

      var row = document.createElement("div");
      row.className = "softu-card__row";

      row.appendChild(createChip(formatDate(vod.createdAt), false));
      if (vod.chatReplayAvailable !== false) {
        row.appendChild(createChip("Chat Replay", true));
      } else {
        row.appendChild(createChip("No Chat", false));
      }
      if (vod.duration) row.appendChild(createChip(compactDuration(String(vod.duration)), false));

      meta.appendChild(title);
      meta.appendChild(row);

      card.appendChild(thumb);
      card.appendChild(meta);
      fragment.appendChild(card);
    });

    listEl.appendChild(fragment);
    listEl.classList.remove("is-hidden");
  }

  function createChip(text, accent) {
    var chip = document.createElement("span");
    chip.className = "softu-chip" + (accent ? " softu-chip--accent" : "");
    chip.textContent = text;
    return chip;
  }

  function compactDuration(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.indexOf(":") !== -1) return raw;
    return raw
      .replace(/\bhours?\b/gi, "h")
      .replace(/\bminutes?\b/gi, "m")
      .replace(/\bseconds?\b/gi, "s")
      .replace(/,\s*/g, "")
      .replace(/\s+/g, "");
  }

  function setLoading(loading) {
    if (!loadingEl) return;
    loadingEl.classList.toggle("is-hidden", !loading);
    if (loading && listEl) listEl.classList.add("is-hidden");
  }

  function setError(message) {
    if (!errorEl) return;
    if (!message) {
      errorEl.classList.add("is-hidden");
      errorEl.textContent = "";
      return;
    }
    errorEl.textContent = message;
    errorEl.classList.remove("is-hidden");
  }
})();
