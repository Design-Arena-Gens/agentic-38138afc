"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type JoinedRoomPayload = {
  participants: number;
};

type PeerEventPayload = {
  participantId: string;
  participants?: number;
};

type SignalDescription = {
  type: "offer" | "answer";
  sdp: string;
};

type IceCandidatePayload = {
  candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
  participantId: string;
};

type OfferPayload = {
  description: SignalDescription;
  participantId: string;
};

type CallRoomProps = {
  initialRoomId?: string | null;
};

const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
    ],
  },
];

const generateRoomCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const CallRoom = ({ initialRoomId }: CallRoomProps) => {
  const [roomId, setRoomId] = useState<string>(() => {
    if (initialRoomId && initialRoomId.trim().length > 0) {
      return initialRoomId.trim().toUpperCase();
    }
    return "";
  });
  const [status, setStatus] = useState<string>("Idle");
  const [error, setError] = useState<string>("");
  const [participants, setParticipants] = useState<number>(0);
  const [isJoining, setIsJoining] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true);
  const [shareLinkCopied, setShareLinkCopied] = useState<boolean>(false);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const roomIdRef = useRef<string>("");

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  const hasMediaSupport = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices !== "undefined" &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    );
  }, []);

  const cleanupStreams = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, []);

  const closePeerConnection = useCallback(() => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null;
      peerRef.current.ontrack = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }
  }, []);

  const leaveRoom = useCallback(
    (notifyPeer = true) => {
      const activeRoom = roomIdRef.current;
      if (notifyPeer && socketRef.current && activeRoom) {
        socketRef.current.emit("leave", { roomId: activeRoom });
      }
      closePeerConnection();
      cleanupStreams();
      setParticipants(0);
      setIsConnected(false);
      setAudioEnabled(true);
      setVideoEnabled(true);
      setStatus("Idle");
    },
    [cleanupStreams, closePeerConnection],
  );

  const createPeerConnection = useCallback(() => {
    const peerConnection = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });

    peerRef.current = peerConnection;

    const handleIceCandidate = (event: RTCPeerConnectionIceEvent) => {
      const activeRoom = roomIdRef.current;
      if (event.candidate && socketRef.current && activeRoom) {
        socketRef.current.emit("ice-candidate", {
          roomId: activeRoom,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    const handleTrack = (event: RTCTrackEvent) => {
      const stream = event.streams[0];
      if (!stream) {
        return;
      }

      remoteStreamRef.current = stream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

    const handleConnectionState = () => {
      switch (peerConnection.connectionState) {
        case "connected":
          setIsConnected(true);
          setStatus("Connected");
          break;
        case "connecting":
          setStatus("Connecting…");
          break;
        case "disconnected":
          setStatus("Disconnected");
          setIsConnected(false);
          break;
        case "failed":
          setStatus("Connection failed");
          setError("Peer connection failed. Please try rejoining the room.");
          leaveRoom(false);
          break;
        case "closed":
          setStatus("Connection closed");
          setIsConnected(false);
          break;
      }
    };

    peerConnection.onicecandidate = handleIceCandidate;
    peerConnection.ontrack = handleTrack;
    peerConnection.onconnectionstatechange = handleConnectionState;

    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }

    return peerConnection;
  }, [leaveRoom]);

  const ensureLocalStream = useCallback(async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }
    if (!hasMediaSupport) {
      throw new Error(
        "Media devices are not supported in this browser. Please try a modern browser.",
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    stream.getAudioTracks().forEach((track) => {
      track.enabled = audioEnabled;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = videoEnabled;
    });

    return stream;
  }, [audioEnabled, videoEnabled, hasMediaSupport]);

  const attachLocalTracks = useCallback(
    async (peerConnection: RTCPeerConnection) => {
      const stream = await ensureLocalStream();
      stream.getTracks().forEach((track) => {
        const sender = peerConnection
          .getSenders()
          .find((existingSender) => existingSender.track === track);
        if (!sender) {
          peerConnection.addTrack(track, stream);
        }
      });
    },
    [ensureLocalStream],
  );

  const sendOffer = useCallback(async () => {
    const activeRoom = roomIdRef.current;
    if (!peerRef.current || !socketRef.current || !activeRoom) return;
    try {
      const offer = await peerRef.current.createOffer();
      await peerRef.current.setLocalDescription(offer);
      socketRef.current.emit(
        "offer",
        {
          roomId: activeRoom,
          description: offer,
        },
        () => {
          setStatus("Offer sent");
        },
      );
    } catch (err) {
      setError("Unable to create an offer. Please retry.");
    }
  }, []);

  const joinRoom = useCallback(async () => {
    if (isJoining) return;
    setError("");

    let targetRoom = roomId.trim();
    if (!targetRoom) {
      targetRoom = generateRoomCode();
    }
    targetRoom = targetRoom.toUpperCase();

    if (!socketRef.current) {
      setError("Socket is not ready yet. Please wait a second and retry.");
      return;
    }

    setRoomId(targetRoom);
    roomIdRef.current = targetRoom;

    setIsJoining(true);
    setStatus("Preparing devices…");

    try {
      const peerConnection = peerRef.current ?? createPeerConnection();
      await attachLocalTracks(peerConnection);
      socketRef.current.emit("join", { roomId: targetRoom });
      setStatus("Waiting for others to join…");
      setParticipants((prev) => Math.max(prev, 1));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to access camera/mic.",
      );
      leaveRoom(false);
    } finally {
      setIsJoining(false);
    }
  }, [attachLocalTracks, createPeerConnection, isJoining, leaveRoom, roomId]);

  const endCall = useCallback(() => {
    leaveRoom(true);
  }, [leaveRoom]);

  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !audioEnabled;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    setAudioEnabled(next);
  }, [audioEnabled]);

  const toggleVideo = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoEnabled;
    stream.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
    setVideoEnabled(next);
  }, [videoEnabled]);

  const copyShareLink = useCallback(async () => {
    const normalizedRoomId = roomId.trim().toUpperCase();
    if (!normalizedRoomId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("room", normalizedRoomId);
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareLinkCopied(true);
      setTimeout(() => setShareLinkCopied(false), 2000);
    } catch (err) {
      setError("Unable to copy link to clipboard.");
    }
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;

    const setupSocket = async () => {
      try {
        await fetch("/api/socket");
      } catch (err) {
        // The fetch can fail in dev mode when hot reloading; ignore.
      }
      if (cancelled) return;

      const socket = io({
        path: "/api/socket",
        transports: ["websocket", "polling"],
      });

      socketRef.current = socket;

      const updateParticipants = (count: number | undefined) => {
        if (typeof count === "number") {
          setParticipants(count);
        }
      };

      socket.on("connect", () => {
        setStatus("Connected to signaling server");
      });

      socket.on("disconnect", () => {
        setStatus("Disconnected from signaling server");
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
        }
        reconnectTimeout.current = setTimeout(() => {
          socket.connect();
        }, 2000);
      });

      socket.on("joined-room", ({ participants }: JoinedRoomPayload) => {
        updateParticipants(participants);
        setStatus(
          participants > 1
            ? "Connected to peers"
            : "Waiting for others to join…",
        );
      });

      socket.on("room-full", () => {
        setError("This room already has the maximum number of participants.");
        leaveRoom(false);
      });

      socket.on("peer-joined", async ({ participants }: PeerEventPayload) => {
        updateParticipants(participants);
        if (!peerRef.current) {
          const connection = createPeerConnection();
          await attachLocalTracks(connection);
        }
        setStatus("Peer joined. Establishing connection…");
        await sendOffer();
      });

      socket.on("offer", async ({ description }: OfferPayload) => {
        if (!peerRef.current) {
          const connection = createPeerConnection();
          await attachLocalTracks(connection);
        }
        if (!peerRef.current?.currentRemoteDescription) {
          await peerRef.current?.setRemoteDescription(description);
          const answer = await peerRef.current?.createAnswer();
          if (answer) {
            await peerRef.current?.setLocalDescription(answer);
            const activeRoom = roomIdRef.current;
            if (activeRoom) {
              socket.emit("answer", {
                roomId: activeRoom,
                description: answer,
              });
              setStatus("Answer sent");
            }
          }
        }
      });

      socket.on("answer", async ({ description }: OfferPayload) => {
        if (peerRef.current?.signalingState === "have-local-offer") {
          await peerRef.current.setRemoteDescription(description);
          setStatus("Call connected");
        }
      });

      socket.on(
        "ice-candidate",
        async ({ candidate }: IceCandidatePayload) => {
          if (peerRef.current) {
            try {
              await peerRef.current.addIceCandidate(candidate);
            } catch (err) {
              console.error("Error adding received ICE candidate", err);
            }
          }
        },
      );

      socket.on("peer-left", () => {
        setStatus("Peer disconnected");
        setParticipants((current) => Math.max(0, current - 1));
        closePeerConnection();
        remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
        remoteStreamRef.current = null;
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
      });

      socket.on("connect_error", (err) => {
        setError(`Signaling connection error: ${err.message}`);
      });
    };

    setupSocket();

    return () => {
      cancelled = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      socketRef.current?.disconnect();
      socketRef.current = null;
      leaveRoom(false);
    };
  }, [attachLocalTracks, closePeerConnection, createPeerConnection, leaveRoom, sendOffer]);

  useEffect(() => {
    if (!localVideoRef.current) return;
    const videoElement = localVideoRef.current;
    videoElement.muted = true;
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const activeRoom = roomIdRef.current;
      if (socketRef.current && activeRoom) {
        socketRef.current.emit("leave", { roomId: activeRoom });
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const isCallActive = useMemo(
    () => isConnected && participants > 0,
    [isConnected, participants],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2 text-center sm:text-left">
        <h1 className="text-3xl font-semibold text-slate-800 dark:text-slate-100 sm:text-4xl">
          Aurora Connect
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300 sm:text-base">
          Create a room and share the link for instant peer-to-peer audio and
          video calls in your browser.
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-950/80">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="size-full object-cover"
              />
              <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
                You
              </span>
            </div>
            <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-800">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="size-full object-cover"
              />
              <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
                Remote participant
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={toggleAudio}
                className={`rounded-full px-4 py-2 text-sm font-medium shadow transition ${
                  audioEnabled
                    ? "bg-slate-900 text-white hover:bg-slate-800"
                    : "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200"
                }`}
                disabled={!isCallActive}
              >
                {audioEnabled ? "Mute" : "Unmute"}
              </button>
              <button
                onClick={toggleVideo}
                className={`rounded-full px-4 py-2 text-sm font-medium shadow transition ${
                  videoEnabled
                    ? "bg-slate-900 text-white hover:bg-slate-800"
                    : "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200"
                }`}
                disabled={!isCallActive}
              >
                {videoEnabled ? "Turn Camera Off" : "Turn Camera On"}
              </button>
            </div>

            <button
              onClick={endCall}
              className="rounded-full bg-rose-600 px-6 py-2 text-sm font-semibold text-white shadow hover:bg-rose-700 disabled:pointer-events-none disabled:opacity-60"
              disabled={!isCallActive}
            >
              End Call
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="room-id"
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              Room Code
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="room-id"
                value={roomId}
                onChange={(event) =>
                  setRoomId(event.target.value.toUpperCase())
                }
                placeholder="Enter or create a room code"
                className="w-full rounded-xl border border-slate-200 px-4 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                onClick={joinRoom}
                disabled={isJoining}
                className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isJoining ? "Connecting…" : "Start / Join"}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Share this code with teammates to join the same room. Up to four
              participants are supported per room.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Status
            </span>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {status}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Participants
            </span>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {participants}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Share Link
            </span>
            <button
              onClick={copyShareLink}
              disabled={!roomId.trim()}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {shareLinkCopied ? "Link copied!" : "Copy invite link"}
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Anyone with the link can join immediately. Share wisely.
            </p>
          </div>

          {!hasMediaSupport && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-200">
              Your browser does not support the necessary media APIs for video
              calls. Please use a recent version of Chrome, Firefox, Safari, or
              Edge.
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm dark:border-rose-700/70 dark:bg-rose-950/40 dark:text-rose-200">
              {error}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default CallRoom;
