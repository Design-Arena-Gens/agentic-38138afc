import type { NextApiRequest } from "next";
import type { NextApiResponse } from "next";
import type { Server as HTTPServer } from "http";
import type { Server as IOServer, Socket } from "socket.io";
import { Server } from "socket.io";

type ServerWithIO = HTTPServer & {
  io?: IOServer;
};

type NextApiResponseServerIO = NextApiResponse & {
  socket: NextApiResponse["socket"] & {
    server: ServerWithIO;
  };
};

type JoinPayload = {
  roomId: string;
};

type SessionDescription = {
  type: "offer" | "answer";
  sdp: string;
};

type IceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

type SignalPayload = {
  roomId: string;
  description?: SessionDescription;
  candidate?: IceCandidate;
};

const MAX_ROOM_SIZE = 4;

const ensureSocketServer = (
  res: NextApiResponseServerIO,
): IOServer | undefined => {
  if (!res.socket?.server) {
    return undefined;
  }

  if (!res.socket.server.io) {
    const io = new Server(res.socket.server, {
      path: "/api/socket",
      cors: {
        origin: "*",
      },
    });

    io.on("connection", (socket: Socket) => {
      socket.on("join", ({ roomId }: JoinPayload) => {
        if (!roomId) return;

        const room = io.sockets.adapter.rooms.get(roomId);
        const occupants = room ? room.size : 0;

        if (occupants >= MAX_ROOM_SIZE) {
          socket.emit("room-full");
          return;
        }

        socket.join(roomId);
        const updatedRoom = io.sockets.adapter.rooms.get(roomId);
        const updatedOccupants = updatedRoom ? updatedRoom.size : 0;

        socket.emit("joined-room", { participants: updatedOccupants });
        socket.to(roomId).emit("peer-joined", {
          participantId: socket.id,
          participants: updatedOccupants,
        });
      });

      socket.on("leave", ({ roomId }: JoinPayload) => {
        if (!roomId) return;
        socket.leave(roomId);
        socket.to(roomId).emit("peer-left", {
          participantId: socket.id,
        });
      });

      socket.on(
        "offer",
        ({ roomId, description }: SignalPayload, ack?: () => void) => {
          if (!roomId || !description) return;
          socket.to(roomId).emit("offer", {
            description,
            participantId: socket.id,
          });
          ack?.();
        },
      );

      socket.on(
        "answer",
        ({ roomId, description }: SignalPayload, ack?: () => void) => {
          if (!roomId || !description) return;
          socket.to(roomId).emit("answer", {
            description,
            participantId: socket.id,
          });
          ack?.();
        },
      );

      socket.on("ice-candidate", ({ roomId, candidate }: SignalPayload) => {
        if (!roomId || !candidate) return;
        socket.to(roomId).emit("ice-candidate", {
          candidate,
          participantId: socket.id,
        });
      });

      socket.on("disconnecting", () => {
        socket.rooms.forEach((roomId) => {
          if (roomId === socket.id) return;
          socket.to(roomId).emit("peer-left", {
            participantId: socket.id,
          });
        });
      });
    });

    res.socket.server.io = io;
  }

  return res.socket.server.io;
};

export default function handler(
  _req: NextApiRequest,
  res: NextApiResponseServerIO,
) {
  const io = ensureSocketServer(res);
  if (!io) {
    res.status(500).json({ message: "Socket server unavailable" });
    return;
  }

  res.end();
}

export const config = {
  api: {
    bodyParser: false,
  },
};
