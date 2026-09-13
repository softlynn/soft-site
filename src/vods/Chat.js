import React, { useEffect, useState, useRef, createRef, useCallback } from "react";
import { Box, Typography, Tooltip, Divider, Collapse, styled, IconButton, Button } from "@mui/material";
import SimpleBar from "simplebar-react";
import Loading from "../utils/Loading";
import KeyboardDoubleArrowLeftRoundedIcon from "@mui/icons-material/KeyboardDoubleArrowLeftRounded";
import KeyboardDoubleArrowRightRoundedIcon from "@mui/icons-material/KeyboardDoubleArrowRightRounded";
import { collapseClasses } from "@mui/material/Collapse";
import Twemoji from "react-twemoji";
import Settings from "./Settings";
import { toHHMMSS } from "../utils/helpers";
import SettingsIcon from "@mui/icons-material/Settings";
import MessageTooltip from "./MessageTooltip";
import { BTTV_EMOTE_CDN } from "../config/site";
import { getBadges, getEmotes, getVodComments } from "../api/vodsApi";
import ThemeModeToggle from "../utils/ThemeModeToggle";
import { findReplayEnd, indexEmotes } from "./replayUtils.mjs";

const SEVENTV_API = "https://7tv.io/v3";
const BASE_TWITCH_CDN = "https://static-cdn.jtvnw.net";
const BASE_FFZ_EMOTE_CDN = "https://cdn.frankerfacez.com/emote";
const BASE_BTTV_EMOTE_CDN = BTTV_EMOTE_CDN;
const BASE_7TV_EMOTE_CDN = "https://cdn.7tv.app/emote";
const CHAT_SEEK_BACKFILL_SECONDS = 180;
const CHAT_VISIBLE_MESSAGE_LIMIT = 500;
const emoteIndexes = new WeakMap();
const findEmote = (entries, text) => {
  if (!Array.isArray(entries)) return undefined;
  if (!emoteIndexes.has(entries)) emoteIndexes.set(entries, indexEmotes(entries));
  return emoteIndexes.get(entries).get(text);
};
const FALLBACK_BADGE_LABELS = {
  broadcaster: "LIVE",
  moderator: "MOD",
  vip: "VIP",
  subscriber: "SUB",
  founder: "FDR",
  bits: "BITS",
  "bits-leader": "BITS",
  premium: "PRIME",
  "bot-badge": "BOT",
  "7tv": "7TV",
};

let messageCount = 0;
let badgesCount = 0;

const getBadgeSetId = (badge) => String(badge?._id ?? badge?.setID ?? badge?.set_id ?? "").trim();

const getBadgeVersion = (badge) => String(badge?.version ?? badge?.id ?? "").trim();

const formatBadgeTitle = (badgeId, version) => {
  const readableBadgeId = String(badgeId || "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!readableBadgeId) return "Badge";
  if (!version) return readableBadgeId;
  return `${readableBadgeId} (${version})`;
};

const getFallbackBadgeLabel = (badgeId) => {
  const normalized = String(badgeId || "").trim().toLowerCase();
  if (!normalized) return "BADGE";
  if (FALLBACK_BADGE_LABELS[normalized]) return FALLBACK_BADGE_LABELS[normalized];
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase())
    .join("")
    .slice(0, 7) || "BADGE";
};

export default function Chat(props) {
  const { isPortrait, vodId, playerRef, playing, userChatDelay, delay, youtube, part, games, chatReplayAvailable = true, forceSideLayout = false, showChat: controlledShowChat, onShowChatChange } = props;
  const desktopExpandedWidth = "clamp(300px, 22vw, 360px)";
  const desktopCollapsedWidth = "52px";
  const sideLayout = forceSideLayout || !isPortrait;
  const expandedPanelWidth = forceSideLayout ? "clamp(240px, 38vw, 340px)" : desktopExpandedWidth;
  const expandedPanelMinWidth = forceSideLayout ? "clamp(220px, 30vw, 300px)" : desktopExpandedWidth;
  const [internalShowChat, setInternalShowChat] = useState(true);
  const showChat = typeof controlledShowChat === "boolean" ? controlledShowChat : internalShowChat;
  const [shownMessages, setShownMessages] = useState([]);
  const comments = useRef([]);
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [commentsCount, setCommentsCount] = useState(0);
  const badges = useRef();
  const emotes = useRef({ ffz_emotes: [], bttv_emotes: [], "7tv_emotes": [] });
  const cursor = useRef();
  const loopRef = useRef();
  const playRef = useRef();
  const chatRef = useRef();
  const stoppedAtIndex = useRef(0);
  const newMessages = useRef();
  const lastPlaybackTimeRef = useRef(null);
  const commentsRequestSeqRef = useRef(0);
  const hasInitializedSyncRef = useRef(false);
  const [scrolling, setScrolling] = useState(false);
  const scrollingRef = useRef(false);
  const historyExpansionPending = useRef(false);
  const [showTimestamp, setShowTimestamp] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [chatSyncing, setChatSyncing] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(CHAT_VISIBLE_MESSAGE_LIMIT);

  const applyCommentsPage = useCallback((response) => {
    const nextComments = Array.isArray(response?.comments) ? response.comments : [];
    comments.current = nextComments;
    cursor.current = response?.cursor ?? null;
    setCommentsCount(nextComments.length);
    setCommentsLoaded(true);
    setChatSyncing(false);
    return nextComments;
  }, []);

  const requestComments = useCallback(
    async ({ cursor: nextCursor, contentOffsetSeconds } = {}, { resetIndex = false } = {}) => {
      const requestSeq = ++commentsRequestSeqRef.current;
      try {
        const response = await getVodComments(vodId, { cursor: nextCursor, contentOffsetSeconds });
        if (requestSeq !== commentsRequestSeqRef.current) return null;
        if (resetIndex) stoppedAtIndex.current = 0;
        return applyCommentsPage(response);
      } catch (error) {
        if (requestSeq === commentsRequestSeqRef.current) {
          setChatSyncing(false);
        }
        throw error;
      }
    },
    [vodId, applyCommentsPage]
  );

  useEffect(() => {
    if (forceSideLayout) {
      setInternalShowChat(true);
      onShowChatChange?.(true);
    }
  }, [forceSideLayout, onShowChatChange]);

  useEffect(() => {
    comments.current = [];
    cursor.current = null;
    stoppedAtIndex.current = 0;
    setShownMessages([]);
    setCommentsCount(0);
    setCommentsLoaded(false);
    setChatSyncing(false);
    lastPlaybackTimeRef.current = null;
    commentsRequestSeqRef.current += 1;
    hasInitializedSyncRef.current = false;
    setHistoryLimit(CHAT_VISIBLE_MESSAGE_LIMIT);
    scrollingRef.current = false;
    historyExpansionPending.current = false;
    return () => {
      commentsRequestSeqRef.current += 1;
      clearInterval(loopRef.current);
      clearTimeout(playRef.current);
    };
  }, [vodId, part?.part]);

  useEffect(() => {
    if (chatRef && chatRef.current) {
      const ref = chatRef.current;
      const handleScroll = (e) => {
        const atBottom = ref.scrollHeight - ref.clientHeight - ref.scrollTop < 512;
        scrollingRef.current = !atBottom;
        setScrolling((prev) => (prev === !atBottom ? prev : !atBottom));
      };

      ref.addEventListener("scroll", handleScroll, { passive: true });

      return () => ref.removeEventListener("scroll", handleScroll);
    }
  }, [commentsLoaded, showChat, shownMessages.length > 0]);

  useEffect(() => {
    if (!chatReplayAvailable) return;
    let disposed = false;
    emotes.current = { ffz_emotes: [], bttv_emotes: [], "7tv_emotes": [], embedded_emotes: [] };

    const loadBadges = () => {
      getBadges()
        .then((data) => {
          if (disposed || data.error) return;
          badges.current = data;
        })
        .catch((e) => {
          console.error(e);
        });
    };

    const load7TVGlobalEmotes = () => {
      fetch(`${SEVENTV_API}/emote-sets/global`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then((response) => response.json())
        .then((data) => {
          if (disposed || !Array.isArray(data.emotes)) return;
          emotes.current["7tv_emotes"] = (emotes.current["7tv_emotes"] || []).concat(data.emotes);
        })
        .catch((e) => {
          console.error(e);
        });
    };

    const loadEmotes = async () => {
      await getEmotes(vodId)
        .then((data) => {
          if (disposed || data.error) return;
          emotes.current = data.data?.[0] || emotes.current;
        })
        .catch((e) => {
          console.error(e);
        });
      if (!disposed) load7TVGlobalEmotes();
    };

    loadEmotes();
    loadBadges();
    return () => { disposed = true; };
  }, [vodId, chatReplayAvailable]);

  const getCurrentTime = useCallback(() => {
    if (!playerRef.current) return 0;
    let time = 0;
    if (youtube) {
      for (let video of youtube) {
        if (!video.part) break;
        if (video.part >= part.part) break;
        time += Number(video.duration) || 0;
      }
      time += playerRef.current.getCurrentTime();
    } else if (games) {
      time += Number(games[part.part - 1]?.start_time) || 0;
      time += playerRef.current.getCurrentTime();
    } else {
      time += playerRef.current.currentTime();
    }
    time += delay;
    // Positive userChatDelay means "show chat later", so subtract it from the replay clock.
    time -= userChatDelay;
    return time;
  }, [playerRef, youtube, delay, part, userChatDelay, games]);

  const getSeekFetchOffset = useCallback(
    (time) => {
      const normalized = Number.isFinite(time) ? time : getCurrentTime();
      return Math.max(0, normalized - CHAT_SEEK_BACKFILL_SECONDS);
    },
    [getCurrentTime]
  );

  const buildComments = useCallback((options = {}) => {
    const force = Boolean(options?.force);
    if (!chatReplayAvailable || (!force && document.hidden)) return;
    if (!playerRef.current || !comments.current || comments.current.length === 0 || stoppedAtIndex.current === null) return;
    if (!force && (youtube || games ? playerRef.current.getPlayerState() !== 1 : playerRef.current.paused())) return;

    const time = getCurrentTime();
    const previousTime = lastPlaybackTimeRef.current;
    if (Number.isFinite(previousTime) && Number.isFinite(time) && time + 2 < previousTime) {
      stoppedAtIndex.current = 0;
      setShownMessages([]);
    }
    lastPlaybackTimeRef.current = time;

    const lastIndex = findReplayEnd(comments.current, time);

    if (stoppedAtIndex.current === lastIndex) return;

    const fetchNextComments = () => {
      if (!cursor.current) return;
      requestComments({ cursor: cursor.current }, { resetIndex: true })
        .then((response) => {
          if (!response) return;
        })
        .catch((e) => {
          console.error(e);
        });
    };

    const transformBadges = (textBadges) => {
      if (!Array.isArray(textBadges) || textBadges.length === 0) return null;

      const badgeWrapper = [];
      const channelBadges = Array.isArray(badges.current?.channel) ? badges.current.channel : [];
      const globalBadges = Array.isArray(badges.current?.global) ? badges.current.global : [];

      for (const textBadge of textBadges) {
        const badgeId = getBadgeSetId(textBadge);
        const version = getBadgeVersion(textBadge);
        if (!badgeId) continue;

        const badgeSet =
          channelBadges.find((channelBadge) => channelBadge.set_id === badgeId) ||
          globalBadges.find((globalBadge) => globalBadge.set_id === badgeId);
        const badgeVersion = Array.isArray(badgeSet?.versions)
          ? badgeSet.versions.find((candidate) => String(candidate?.id || "") === version)
          : null;
        const badgeTitle = formatBadgeTitle(badgeId, version);

        if (badgeVersion?.image_url_1x && badgeVersion?.image_url_2x && badgeVersion?.image_url_4x) {
          badgeWrapper.push(
            <MessageTooltip
              key={badgesCount++}
              title={
                <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                  <img
                    crossOrigin="anonymous"
                    style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }}
                    src={badgeVersion.image_url_4x}
                    alt=""
                  />
                  <Typography display="block" variant="caption">{badgeTitle}</Typography>
                </Box>
              }
            >
              <img
                crossOrigin="anonymous"
                style={{ display: "inline-block", minWidth: "1rem", height: "1rem", margin: "0 .2rem .1rem 0", backgroundPosition: "50%", verticalAlign: "middle" }}
                srcSet={`${badgeVersion.image_url_1x} 1x, ${badgeVersion.image_url_2x} 2x, ${badgeVersion.image_url_4x} 4x`}
                src={badgeVersion.image_url_1x}
                alt=""
              />
            </MessageTooltip>
          );
          continue;
        }

        badgeWrapper.push(
          <MessageTooltip
            key={badgesCount++}
            title={
              <Typography variant="caption" sx={{ display: "block", maxWidth: "16rem", textAlign: "center" }}>
                {badgeTitle}
              </Typography>
            }
          >
            <Box
              component="span"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: "1rem",
                height: "1rem",
                px: 0.35,
                mr: 0.4,
                mb: 0.1,
                borderRadius: "999px",
                background: "rgba(127, 153, 196, 0.2)",
                border: "1px solid rgba(173, 197, 233, 0.28)",
                color: "rgba(229, 239, 255, 0.92)",
                fontSize: "0.52rem",
                fontWeight: 700,
                letterSpacing: "0.03em",
                lineHeight: 1,
                verticalAlign: "middle",
              }}
            >
              {getFallbackBadgeLabel(badgeId)}
            </Box>
          </MessageTooltip>
        );
      }

      if (badgeWrapper.length === 0) return null;
      return <Box sx={{ display: "inline" }}>{badgeWrapper}</Box>;
    };

    const transformMessage = (fragments) => {
      if (!fragments) return;

      const textFragments = [];
      for (let i = 0; i < fragments.length; i++) {
        const fragment = fragments[i];
        if (fragment.emote) {
          textFragments.push(
            <MessageTooltip
              key={messageCount++}
              title={
                <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                  <img
                    crossOrigin="anonymous"
                    style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }}
                    src={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emote.emoteID}/default/dark/3.0`}
                    alt=""
                  />
                  <Typography display="block" variant="caption">{`Emote: ${fragment.text}`}</Typography>
                  <Typography display="block" variant="caption">
                    {`Twitch Emotes`}
                  </Typography>
                </Box>
              }
            >
              <Box sx={{ display: "inline" }}>
                <img
                  crossOrigin="anonymous"
                  style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }}
                  src={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emote.emoteID}/default/dark/1.0`}
                  srcSet={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emote.emoteID}/default/dark/1.0 1x, ${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emote.emoteID}/default/dark/2.0 2x, ${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emote.emoteID}/default/dark/3.0 4x`}
                  alt={fragment.text}
                />{" "}
              </Box>
            </MessageTooltip>
          );
          continue;
        }

        if (fragment.emoticon) {
          textFragments.push(
            <MessageTooltip
              key={messageCount++}
              title={
                <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                  <img
                    crossOrigin="anonymous"
                    style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }}
                    src={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emoticon.emoticon_id}/default/dark/3.0`}
                    alt=""
                  />
                  <Typography display="block" variant="caption">{`Emote: ${fragment.text}`}</Typography>
                  <Typography display="block" variant="caption">
                    {`Twitch Emotes`}
                  </Typography>
                </Box>
              }
            >
              <Box sx={{ display: "inline" }}>
                <img
                  crossOrigin="anonymous"
                  style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }}
                  src={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emoticon.emoticon_id}/default/dark/1.0`}
                  srcSet={`${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emoticon.emoticon_id}/default/dark/1.0 1x, ${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emoticon.emoticon_id}/default/dark/2.0 2x, ${BASE_TWITCH_CDN}/emoticons/v2/${fragment.emoticon.emoticon_id}/default/dark/3.0 4x`}
                  alt={fragment.text}
                />{" "}
              </Box>
            </MessageTooltip>
          );
          continue;
        }

        let textArray = fragment.text.split(" ");

        for (let text of textArray) {
          if (emotes.current) {
            const SEVENTV_EMOTES = emotes.current["7tv_emotes"];
            const BTTV_EMOTES = emotes.current["bttv_emotes"];
            const FFZ_EMOTES = emotes.current["ffz_emotes"];
            const EMBEDDED_EMOTES = emotes.current["embedded_emotes"];

            if (EMBEDDED_EMOTES) {
              const emote = findEmote(EMBEDDED_EMOTES, text);
              if (emote) {
                const embeddedSrc = emote.data ? `data:image/webp;base64,${emote.data}` : `${BASE_7TV_EMOTE_CDN}/${emote.id}/4x.webp`;
                const embeddedSrcSmall = emote.data ? `data:image/webp;base64,${emote.data}` : `${BASE_7TV_EMOTE_CDN}/${emote.id}/1x.webp`;

                textFragments.push(
                  <MessageTooltip
                    key={messageCount++}
                    title={
                      <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                        <img crossOrigin="anonymous" style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }} src={embeddedSrc} alt="" />
                        <Typography display="block" variant="caption">{`Emote: ${emote.name || emote.code}`}</Typography>
                        <Typography display="block" variant="caption">
                          Third-Party Emotes
                        </Typography>
                      </Box>
                    }
                  >
                    <Box sx={{ display: "inline" }}>
                      <img crossOrigin="anonymous" style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }} src={embeddedSrcSmall} alt={text} />{" "}
                    </Box>
                  </MessageTooltip>
                );
                continue;
              }
            }

            if (SEVENTV_EMOTES) {
              const emote = findEmote(SEVENTV_EMOTES, text);
              if (emote) {
                textFragments.push(
                  <MessageTooltip
                    key={messageCount++}
                    title={
                      <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                        <img
                          crossOrigin="anonymous"
                          style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }}
                          src={`${BASE_7TV_EMOTE_CDN}/${emote.id}/4x.webp`}
                          alt=""
                        />
                        <Typography display="block" variant="caption">{`Emote: ${emote.name || emote.code}`}</Typography>
                        <Typography display="block" variant="caption">
                          7TV Emotes
                        </Typography>
                      </Box>
                    }
                  >
                    <Box sx={{ display: "inline" }}>
                      <img
                        crossOrigin="anonymous"
                        style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }}
                        src={`${BASE_7TV_EMOTE_CDN}/${emote.id}/1x.webp`}
                        srcSet={`${BASE_7TV_EMOTE_CDN}/${emote.id}/1x.webp 1x, ${BASE_7TV_EMOTE_CDN}/${emote.id}/2x.webp 2x, ${BASE_7TV_EMOTE_CDN}/${emote.id}/3x.webp 3x, ${BASE_7TV_EMOTE_CDN}/${emote.id}/4x.webp 4x`}
                        alt={text}
                      />{" "}
                    </Box>
                  </MessageTooltip>
                );
                continue;
              }
            }

            if (FFZ_EMOTES) {
              const emote = findEmote(FFZ_EMOTES, text);
              if (emote) {
                textFragments.push(
                  <MessageTooltip
                    key={messageCount++}
                    title={
                      <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                        <img crossOrigin="anonymous" style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }} src={`${BASE_FFZ_EMOTE_CDN}/${emote.id}/4`} alt="" />
                        <Typography display="block" variant="caption">{`Emote: ${emote.name || emote.code}`}</Typography>
                        <Typography display="block" variant="caption">
                          FFZ Emotes
                        </Typography>
                      </Box>
                    }
                  >
                    <Box key={messageCount++} style={{ display: "inline" }}>
                      <img
                        crossOrigin="anonymous"
                        style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }}
                        src={`${BASE_FFZ_EMOTE_CDN}/${emote.id}/1`}
                        srcSet={`${BASE_FFZ_EMOTE_CDN}/${emote.id}/1 1x, ${BASE_FFZ_EMOTE_CDN}/${emote.id}/2 2x, ${BASE_FFZ_EMOTE_CDN}/${emote.id}/4 4x`}
                        alt={text}
                      />{" "}
                    </Box>
                  </MessageTooltip>
                );
                continue;
              }
            }

            if (BTTV_EMOTES) {
              const emote = findEmote(BTTV_EMOTES, text);
              if (emote) {
                textFragments.push(
                  <MessageTooltip
                    key={messageCount++}
                    title={
                      <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                        <img crossOrigin="anonymous" style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }} src={`${BASE_BTTV_EMOTE_CDN}/${emote.id}/3x`} alt="" />
                        <Typography display="block" variant="caption">{`Emote: ${emote.name || emote.code}`}</Typography>
                        <Typography display="block" variant="caption">
                          BTTV Emotes
                        </Typography>
                      </Box>
                    }
                  >
                    <Box key={messageCount++} style={{ display: "inline" }}>
                      <img
                        crossOrigin="anonymous"
                        style={{ verticalAlign: "middle", border: "none", maxWidth: "100%" }}
                        src={`${BASE_BTTV_EMOTE_CDN}/${emote.id}/1x`}
                        srcSet={`${BASE_BTTV_EMOTE_CDN}/${emote.id}/1x 1x, ${BASE_BTTV_EMOTE_CDN}/${emote.id}/2x 2x, ${BASE_BTTV_EMOTE_CDN}/${emote.id}/3x 3x`}
                        alt={text}
                      />{" "}
                    </Box>
                  </MessageTooltip>
                );
                continue;
              }
            }
          }

          textFragments.push(`${text} `);
        }
      }
      return <Twemoji noWrapper options={{ className: "twemoji" }}><Box component="span" sx={{ display: "inline", fontSize: "1rem" }}>{textFragments}</Box></Twemoji>;
    };

    const messages = [];
    const firstIndex = Math.max(stoppedAtIndex.current, lastIndex - historyLimit);
    for (let i = firstIndex; i < lastIndex; i++) {
      const comment = comments.current[i];
      if (!comment.message) continue;
      messages.push(
        <Box key={comment.id} ref={createRef()} sx={{ width: "100%" }}>
          <Box sx={{ alignItems: "flex-start", display: "flex", flexWrap: "nowrap", width: "100%", pl: 0.5, pt: 0.5, pr: 0.5 }}>
            <Box sx={{ display: "flex", alignItems: "flex-start" }}>
              {showTimestamp && (
                <Box sx={{ display: "inline", pl: 1, pr: 1 }}>
                  <Typography variant="caption" sx={{ color: "rgba(219,232,255,0.72)" }}>
                    {toHHMMSS(comment.content_offset_seconds)}
                  </Typography>
                </Box>
              )}
              <Box sx={{ flexGrow: 1 }}>
                {comment.user_badges && transformBadges(comment.user_badges)}
                <Box sx={{ textDecoration: "none", display: "inline" }}>
                  <span style={{ color: comment.user_color, fontWeight: 600 }}>{comment.display_name}</span>
                </Box>
                <Box sx={{ display: "inline" }}>
                  <span>: </span>
                  {transformMessage(comment.message)}
                </Box>
              </Box>
            </Box>
          </Box>
        </Box>
      );
    }

    newMessages.current = messages;

    setShownMessages((shownMessages) => {
      const nextMessages = shownMessages.concat(messages);
      return scrollingRef.current ? nextMessages : nextMessages.slice(-historyLimit);
    });
    stoppedAtIndex.current = lastIndex;
    if (comments.current.length === lastIndex) fetchNextComments();
  }, [chatReplayAvailable, getCurrentTime, playerRef, youtube, games, showTimestamp, requestComments, historyLimit]);

  const loop = useCallback(() => {
    if (loopRef.current !== null) clearInterval(loopRef.current);
    buildComments();
    loopRef.current = setInterval(buildComments, 400);
  }, [buildComments]);

  useEffect(() => () => {
    clearInterval(loopRef.current);
    clearTimeout(playRef.current);
  }, []);

  useEffect(() => {
    if (!chatReplayAvailable) return;

    if (!playing.playing || stoppedAtIndex.current === undefined) return;
    const fetchComments = (offset = 0) => {
      requestComments({ contentOffsetSeconds: getSeekFetchOffset(offset) }, { resetIndex: false })
        .then((response) => {
          if (!response) return;
          buildComments({ force: true });
        })
        .catch((e) => {
          console.error(e);
        });
    };

    const time = getCurrentTime();

    if (comments.current && comments.current.length > 0) {
      const lastComment = comments.current[comments.current.length - 1];
      const firstComment = comments.current[0];
      const stoppedComment = comments.current[stoppedAtIndex.current];

      if (time - lastComment.content_offset_seconds <= 30 && time > firstComment.content_offset_seconds) {
        if (stoppedComment && stoppedComment.content_offset_seconds - time >= 4) {
          stoppedAtIndex.current = 0;
          setShownMessages([]);
        }
        loop();
        return;
      }
    }
    if (playRef.current) clearTimeout(playRef.current);
    playRef.current = setTimeout(() => {
      stopLoop();
      stoppedAtIndex.current = 0;
      comments.current = [];
      cursor.current = null;
      setShownMessages([]);
      setCommentsCount(0);
      setCommentsLoaded(false);
      setChatSyncing(true);
      fetchComments(time);
      loop();
    }, 100);
    return () => {
      stopLoop();
    };
  }, [playing, vodId, getCurrentTime, loop, chatReplayAvailable, requestComments, getSeekFetchOffset, buildComments]);

  // Initial/setting-change sync: rebuild chat for current player time (works even while paused).
  useEffect(() => {
    if (!chatReplayAvailable) return;
    if (delay === undefined) return;

    const syncChat = () => {
      if (playerRef.current) {
        const videoTime = getCurrentTime();
        if (!Number.isFinite(videoTime)) return;
        stoppedAtIndex.current = 0;
        setShownMessages([]);
        setCommentsLoaded(false);
        setCommentsCount(0);
        setChatSyncing(true);
        requestComments({ contentOffsetSeconds: getSeekFetchOffset(videoTime) }, { resetIndex: true })
          .then((data) => {
            if (!data) return;
            buildComments({ force: true });
            if (playing?.playing) loop();
            else stopLoop();
          })
          .catch((e) => console.error(e));
      }
    };

    const isInitialSync = !hasInitializedSyncRef.current;
    hasInitializedSyncRef.current = true;
    const timer = setTimeout(syncChat, isInitialSync ? 220 : 80);
    return () => clearTimeout(timer);
  }, [vodId, part?.part, playerRef, getCurrentTime, loop, buildComments, chatReplayAvailable, requestComments, getSeekFetchOffset, playing?.playing, playing?.ready, delay, userChatDelay]);

  const stopLoop = () => {
    if (loopRef.current !== null) clearInterval(loopRef.current);
    loopRef.current = null;
  };

  useEffect(() => {
    if (!chatRef.current || shownMessages.length === 0) return;
    if (historyExpansionPending.current) {
      historyExpansionPending.current = false;
      chatRef.current.scrollTop = 0;
      scrollingRef.current = true;
      setScrolling(true);
      return;
    }

    let messageHeight = 0;
    for (let message of newMessages.current) {
      if (!message.props.ref.current) continue;
      messageHeight += message.props.ref.current.scrollHeight;
    }
    const height = chatRef.current.scrollHeight - chatRef.current.clientHeight - chatRef.current.scrollTop - messageHeight;
    const atBottom = height < 512;
    if (atBottom) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [shownMessages]);

  const scrollToBottom = () => {
    scrollingRef.current = false;
    setScrolling(false);
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  };

  const handleExpandClick = () => {
    const nextShowChat = !showChat;
    setInternalShowChat(nextShowChat);
    onShowChatChange?.(nextShowChat);
  };

  return (
    <Box
      className="soft-chat-panel"
      sx={{
        height: sideLayout ? "100%" : "clamp(320px, 48dvh, 520px)",
        width: !sideLayout ? "100%" : showChat ? expandedPanelWidth : desktopCollapsedWidth,
        minWidth: !sideLayout ? 0 : showChat ? expandedPanelMinWidth : desktopCollapsedWidth,
        flex: "0 0 auto",
        transition: "none",
        background: "#151619",
        borderLeft: !sideLayout ? "none" : "1px solid rgba(255,255,255,0.08)",
        color: "rgba(234,242,255,0.96)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderRadius: "12px",
        overflow: "hidden",
        boxShadow: "none",
        position: "relative",
      }}
    >
      {showChat ? (
        <>
          <Box sx={{ display: "grid", alignItems: "center", minHeight: 52, p: 0.75 }}>
            {sideLayout && (
              <Box sx={{ justifySelf: "left", gridColumnStart: 1, gridRowStart: 1 }}>
                <Tooltip title="Hide chat">
                  <IconButton onClick={handleExpandClick} aria-expanded={showChat} aria-label="Hide chat" sx={{ color: "inherit", width: 36, height: 36 }}>
                    <KeyboardDoubleArrowRightRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            )}
            <Box sx={{ justifySelf: "center", gridColumnStart: 1, gridRowStart: 1 }}>
              <Typography variant="body1" sx={{ color: "inherit", fontWeight: 700 }}>
                Chat Replay
              </Typography>
            </Box>
            <Box sx={{ justifySelf: "end", gridColumnStart: 1, gridRowStart: 1, display: "flex", alignItems: "center", gap: 0.35 }}>
              <ThemeModeToggle
                variant="inline"
                size="small"
                confirmLightMode={props.confirmLightMode}
                onModeChange={props.onThemeModeChange}
                announceKey={`viewer-${vodId}`}
                sx={{
                  width: 34,
                  height: 34,
                  color: "rgba(234,242,255,0.92)",
                  borderColor: "rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.04)",
                  boxShadow: "none",
                }}
              />
              {chatReplayAvailable && (
                <IconButton title="Settings" aria-label="Chat settings" onClick={() => setShowModal(true)} sx={{ color: "rgba(234,242,255,0.9)" }}>
                  <SettingsIcon />
                </IconButton>
              )}
            </Box>
          </Box>
          <Divider sx={{ borderColor: "rgba(255,255,255,0.08)" }} />
          <CustomCollapse in={showChat} timeout={!sideLayout ? "auto" : 0} unmountOnExit sx={{ minWidth: 0 }}>
            {!chatReplayAvailable ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" sx={{ color: "rgba(219,232,255,0.74)" }}>
                  Chat replay is unavailable for this VOD.
                </Typography>
              </Box>
            ) : !commentsLoaded || chatSyncing ? (
              <Loading />
            ) : commentsCount === 0 || shownMessages.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" sx={{ color: "rgba(219,232,255,0.74)" }}>
                  No chat messages around this timestamp.
                </Typography>
              </Box>
            ) : (
              <>
                <SimpleBar scrollableNodeProps={{ ref: chatRef }} style={{ height: "100%", overflowX: "hidden", borderRadius: "0 0 18px 18px" }}>
                  {stoppedAtIndex.current > historyLimit && (
                    <Button size="small" onClick={() => {
                      historyExpansionPending.current = true;
                      setHistoryLimit((limit) => limit + CHAT_VISIBLE_MESSAGE_LIMIT);
                    }} sx={{ color: "inherit", width: "100%", my: 0.5 }}>
                      Show earlier chat
                    </Button>
                  )}
                  <Box sx={{ display: "flex", justifyContent: "flex-end", flexDirection: "column" }}>
                    <Box sx={{ display: "flex", flexWrap: "wrap", minHeight: 0, alignItems: "flex-end" }}>{shownMessages}</Box>
                  </Box>
                </SimpleBar>
                {scrolling && (
                  <Box sx={{ position: "relative", display: "flex", justifyContent: "center" }}>
                    <Box sx={{ background: "rgba(12,16,28,.74)", minHeight: 0, borderRadius: 1.5, mb: 1, bottom: 0, position: "absolute", border: "1px solid rgba(255,255,255,0.08)" }}>
                      <Button size="small" onClick={scrollToBottom} sx={{ color: "rgba(234,242,255,.95)" }}>
                        Chat Paused
                      </Button>
                    </Box>
                  </Box>
                )}
              </>
            )}
          </CustomCollapse>
        </>
      ) : (
        sideLayout && (
          <Tooltip title="Show chat" placement="left">
            <Button onClick={handleExpandClick} aria-expanded={showChat} aria-label="Show chat"
              sx={{ position: "absolute", inset: 0, minWidth: 0, width: "100%", borderRadius: 0, color: "inherit", display: "flex", flexDirection: "column", gap: 1.2 }}>
              <KeyboardDoubleArrowLeftRoundedIcon fontSize="small" />
              <Typography variant="caption" sx={{ color: "inherit", fontWeight: 600, letterSpacing: "0.1em", writingMode: "vertical-rl", transform: "rotate(180deg)" }}>CHAT</Typography>
            </Button>
          </Tooltip>
        )
      )}
      {chatReplayAvailable && (
        <Settings
          userChatDelay={userChatDelay}
          setUserChatDelay={props.setUserChatDelay}
          showModal={showModal}
          setShowModal={setShowModal}
          showTimestamp={showTimestamp}
          setShowTimestamp={setShowTimestamp}
        />
      )}
    </Box>
  );
}

const CustomCollapse = styled(({ _, ...props }) => <Collapse {...props} />)({
  [`& .${collapseClasses.wrapper}`]: {
    height: "100%",
  },
});
