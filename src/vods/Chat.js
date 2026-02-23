import React, { useEffect, useState, useRef, createRef, useCallback } from "react";
import { Box, Typography, Tooltip, Divider, Collapse, styled, IconButton, Button } from "@mui/material";
import SimpleBar from "simplebar-react";
import Loading from "../utils/Loading";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { collapseClasses } from "@mui/material/Collapse";
import Twemoji from "react-twemoji";
import Settings from "./Settings";
import { toHHMMSS } from "../utils/helpers";
import SettingsIcon from "@mui/icons-material/Settings";
import MessageTooltip from "./MessageTooltip";
import { BTTV_EMOTE_CDN } from "../config/site";
import { getBadges, getEmotes, getVodComments } from "../api/vodsApi";
import ThemeModeToggle from "../utils/ThemeModeToggle";

const SEVENTV_API = "https://7tv.io/v3";
const BASE_TWITCH_CDN = "https://static-cdn.jtvnw.net";
const BASE_FFZ_EMOTE_CDN = "https://cdn.frankerfacez.com/emote";
const BASE_BTTV_EMOTE_CDN = BTTV_EMOTE_CDN;
const BASE_7TV_EMOTE_CDN = "https://cdn.7tv.app/emote";
const CHAT_SEEK_BACKFILL_SECONDS = 180;

let messageCount = 0;
let badgesCount = 0;

export default function Chat(props) {
  const { isPortrait, vodId, playerRef, playing, userChatDelay, delay, youtube, part, games, chatReplayAvailable = true, forceSideLayout = false } = props;
  const desktopExpandedWidth = "clamp(320px, 34vw, 420px)";
  const desktopCollapsedWidth = "46px";
  const sideLayout = forceSideLayout || !isPortrait;
  const expandedPanelWidth = forceSideLayout ? "clamp(240px, 38vw, 340px)" : desktopExpandedWidth;
  const expandedPanelMinWidth = forceSideLayout ? "clamp(220px, 30vw, 300px)" : "clamp(320px, 28vw, 420px)";
  const [showChat, setShowChat] = useState(true);
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
  const [showTimestamp, setShowTimestamp] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [chatSyncing, setChatSyncing] = useState(false);

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
      setShowChat(true);
    }
  }, [forceSideLayout]);

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
  }, [vodId, part?.part]);

  useEffect(() => {
    if (chatRef && chatRef.current) {
      const ref = chatRef.current;
      const handleScroll = (e) => {
        const atBottom = ref.scrollHeight - ref.clientHeight - ref.scrollTop < 512;
        setScrolling((prev) => (prev === !atBottom ? prev : !atBottom));
      };

      ref.addEventListener("scroll", handleScroll, { passive: true });

      return () => ref.removeEventListener("scroll", handleScroll);
    }
  }, []);

  useEffect(() => {
    if (!chatReplayAvailable) return;

    const loadBadges = () => {
      getBadges()
        .then((data) => {
          if (data.error) return;
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
          emotes.current["7tv_emotes"] = emotes.current["7tv_emotes"].concat(data.emotes);
        })
        .catch((e) => {
          console.error(e);
        });
    };

    const loadEmotes = async () => {
      await getEmotes(vodId)
        .then((data) => {
          if (data.error) return;
          emotes.current = data.data[0];
        })
        .catch((e) => {
          console.error(e);
        });
      load7TVGlobalEmotes();
    };

    loadEmotes();
    loadBadges();
  }, [vodId, chatReplayAvailable]);

  const getCurrentTime = useCallback(() => {
    if (!playerRef.current) return 0;
    let time = 0;
    if (youtube) {
      for (let video of youtube) {
        if (!video.part) break;
        if (video.part >= part.part) break;
        time += video.duration;
      }
      time += playerRef.current.getCurrentTime();
    } else if (games) {
      time += parseFloat(games[part.part - 1].start_time);
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
    if (!chatReplayAvailable) return;
    if (!playerRef.current || !comments.current || comments.current.length === 0 || stoppedAtIndex.current === null) return;
    if (!force && (youtube || games ? playerRef.current.getPlayerState() !== 1 : playerRef.current.paused())) return;

    const time = getCurrentTime();
    const previousTime = lastPlaybackTimeRef.current;
    if (Number.isFinite(previousTime) && Number.isFinite(time) && time + 2 < previousTime) {
      stoppedAtIndex.current = 0;
      setShownMessages([]);
    }
    lastPlaybackTimeRef.current = time;

    let lastIndex = comments.current.length;
    for (let i = stoppedAtIndex.current.valueOf(); i < comments.current.length; i++) {
      if (comments.current[i].content_offset_seconds > time) {
        lastIndex = i;
        break;
      }
    }

    if (stoppedAtIndex.current === lastIndex && stoppedAtIndex.current !== 0) return;

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
      const badgeWrapper = [];
      if (!badges.current) return;
      const channelBadges = badges.current.channel;
      const globalBadges = badges.current.global;

      for (const textBadge of textBadges) {
        const badgeId = textBadge._id ?? textBadge.setID;
        const version = textBadge.version;

        if (channelBadges) {
          const badge = channelBadges.find((channelBadge) => channelBadge.set_id === badgeId);
          if (badge) {
            const badgeVersion = badge.versions.find((badgeVersion) => badgeVersion.id === version);
            if (badgeVersion) {
              badgeWrapper.push(
                <MessageTooltip
                  key={badgesCount++}
                  title={
                    <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                      <img crossOrigin="anonymous" style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }} src={badgeVersion.image_url_4x} alt="" />
                      <Typography display="block" variant="caption">{`${badgeId}`}</Typography>
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
          }
        }

        if (globalBadges) {
          const badge = globalBadges.find((globalBadge) => globalBadge.set_id === badgeId);
          if (badge) {
            const badgeVersion = badge.versions.find((badgeVersion) => badgeVersion.id === version);
            badgeWrapper.push(
              <MessageTooltip
                key={badgesCount++}
                title={
                  <Box sx={{ maxWidth: "30rem", textAlign: "center" }}>
                    <img crossOrigin="anonymous" style={{ marginBottom: "0.3rem", border: "none", maxWidth: "100%", verticalAlign: "top" }} src={badgeVersion.image_url_4x} alt="" />
                    <Typography display="block" variant="caption">{`${badgeId}`}</Typography>
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
        }
      }

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
              const emote = EMBEDDED_EMOTES.find((EMBEDDED_EMOTE) => EMBEDDED_EMOTE.name === text || EMBEDDED_EMOTE.code === text);
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
              const emote = SEVENTV_EMOTES.find((SEVENTV_EMOTE) => SEVENTV_EMOTE.name === text || SEVENTV_EMOTE.code === text);
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
              const emote = FFZ_EMOTES.find((FFZ_EMOTE) => FFZ_EMOTE.name === text || FFZ_EMOTE.code === text);
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
              const emote = BTTV_EMOTES.find((BTTV_EMOTE) => BTTV_EMOTE.name === text || BTTV_EMOTE.code === text);
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

          textFragments.push(
            <Twemoji key={messageCount++} noWrapper options={{ className: "twemoji" }}>
              <Typography variant="body1" display="inline">{`${text} `}</Typography>
            </Twemoji>
          );
        }
      }
      return <Box sx={{ display: "inline" }}>{textFragments}</Box>;
    };

    const messages = [];
    for (let i = stoppedAtIndex.current.valueOf(); i < lastIndex; i++) {
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
      return shownMessages.concat(messages);
    });
    stoppedAtIndex.current = lastIndex;
    if (comments.current.length === lastIndex) fetchNextComments();
  }, [chatReplayAvailable, getCurrentTime, playerRef, youtube, games, showTimestamp, requestComments]);

  const loop = useCallback(() => {
    if (loopRef.current !== null) clearInterval(loopRef.current);
    buildComments();
    loopRef.current = setInterval(buildComments, 400);
  }, [buildComments]);

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
  }, [vodId, part?.part, playerRef, getCurrentTime, loop, buildComments, chatReplayAvailable, requestComments, getSeekFetchOffset, playing?.playing, delay, userChatDelay]);

  const stopLoop = () => {
    if (loopRef.current !== null) clearInterval(loopRef.current);
    loopRef.current = null;
  };

  useEffect(() => {
    if (!chatRef.current || shownMessages.length === 0) return;

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
    setScrolling(false);
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  };

  const handleExpandClick = () => {
    setShowChat(!showChat);
  };

  return (
    <Box
      sx={{
        height: "100%",
        width: !sideLayout ? "100%" : showChat ? expandedPanelWidth : desktopCollapsedWidth,
        minWidth: !sideLayout ? 0 : showChat ? expandedPanelMinWidth : desktopCollapsedWidth,
        transition: "none",
        background:
          "linear-gradient(180deg, rgba(16,24,40,0.92), rgba(14,19,31,0.96))",
        borderLeft: !sideLayout ? "none" : "1px solid rgba(255,255,255,0.08)",
        color: "rgba(234,242,255,0.96)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderRadius: "18px",
        overflow: "hidden",
        boxShadow: "0 14px 34px rgba(2,6,18,0.22)",
        position: "relative",
      }}
    >
      {showChat ? (
        <>
          <Box sx={{ display: "grid", alignItems: "center", p: 1 }}>
            {sideLayout && (
              <Box sx={{ justifySelf: "left", gridColumnStart: 1, gridRowStart: 1 }}>
                <Tooltip title="Collapse">
                  <ExpandMore expand={showChat} onClick={handleExpandClick} aria-expanded={showChat}>
                    <ExpandMoreIcon />
                  </ExpandMore>
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
                <IconButton title="Settings" onClick={() => setShowModal(true)} sx={{ color: "rgba(234,242,255,0.9)" }}>
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
          <Box sx={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <Tooltip title="Expand">
              <ExpandMore expand={showChat} onClick={handleExpandClick} aria-expanded={showChat}>
                <ExpandMoreIcon />
              </ExpandMore>
            </Tooltip>
          </Box>
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

const ExpandMore = styled(({ expand, ...props }, ref) => <IconButton {...props} />)`
  margin-left: auto;
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1) 0ms;
  ${(props) =>
    props.expand
      ? `
          transform: rotate(-90deg);
        `
      : `
          transform: rotate(90deg);
        `}
`;
